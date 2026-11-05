import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { packageRoot } from "../src/paths.mjs";

const html = `<!doctype html>
<html><head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="/theme.js"></script>
  <link rel="stylesheet" href="/tokens.css">
  <link rel="stylesheet" href="/@fs/${path.join(packageRoot, "ui/tailwind.css")}">
  <link rel="stylesheet" href="/@fs/${path.join(packageRoot, "ui/styles.css")}">
</head><body><div id="root"></div><script type="module">
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { Button, Checkbox, Input, NativeSelect, Radio, RadioGroup, Textarea } from '/@fs/${path.join(packageRoot, "ui/controls.tsx")}';
  const h = React.createElement;
  const fixture = window.controlsFixture = { cancelReset: false };
  document.addEventListener('reset', event => { if (fixture.cancelReset) event.preventDefault(); }, true);
  function Fixture() {
    const [disabled, setDisabled] = React.useState(false);
    return h('main', null,
      h(Button, { id: 'toggle-disabled', type: 'button', onClick: () => setDisabled(value => !value) }, 'Toggle disabled'),
      h('form', { id: 'controls-form' },
        h('fieldset', { disabled },
          h('label', null, h(Checkbox, { name: 'enabled', defaultChecked: true, disabled }), 'Enabled'),
          h(RadioGroup, { name: 'mode', defaultValue: 'mentions', disabled },
            h('label', null, h(Radio, { value: 'mentions' }), 'Mentions'),
            h('label', null, h(Radio, { value: 'all' }), 'All messages')),
          h('label', null, 'Title', h(Input, { name: 'title', defaultValue: 'Draft' })),
          h('label', null, 'Details', h(Textarea, { name: 'details', defaultValue: 'Notes' })),
          h('label', null, 'Choice', h(NativeSelect, { name: 'choice', defaultValue: 'first' },
            h('option', { value: 'first' }, 'First'), h('option', { value: 'second' }, 'Second')))),
        h(Button, { id: 'reset-controls', variant: 'secondary', type: 'reset' }, 'Reset')));
  }
  createRoot(document.getElementById('root')).render(h(Fixture));
</script></body></html>`;

const temporary = await mkdtemp(path.join(os.tmpdir(), "dscord-ui-controls-"));
const server = await createServer({
  configFile: false,
  root: path.join(packageRoot, "web"),
  cacheDir: path.join(temporary, "vite-cache"),
  plugins: [tailwindcss(), {
    name: "ui-controls-fixture",
    configureServer(vite) {
      vite.middlewares.use("/__controls", async (request, response, next) => {
        if (request.url.includes("html-proxy")) { next(); return; }
        response.setHeader("Content-Type", "text/html");
        response.end(await vite.transformIndexHtml("/__controls", html));
      });
    },
  }],
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "error",
});

const checks = [];
const pageErrors = [];
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__controls`);
  const values = () => page.locator("#controls-form").evaluate((form) => Object.fromEntries(new FormData(form)));
  assert.deepEqual(await values(), { enabled: "on", mode: "mentions", title: "Draft", details: "Notes", choice: "first" });
  checks.push("baseControlsSubmitNativeFormData");

  await page.getByText("Enabled", { exact: true }).click();
  await page.getByText("All messages", { exact: true }).click();
  await page.getByLabel("Title").fill("Changed");
  await page.getByLabel("Details").fill("More");
  await page.getByLabel("Choice").selectOption("second");
  assert.deepEqual(await values(), { mode: "all", title: "Changed", details: "More", choice: "second" });
  checks.push("checkboxAndRadioLabelsChangeHiddenFormInputs");

  const checkbox = page.getByRole("checkbox", { name: "Enabled" });
  await checkbox.focus();
  await page.keyboard.press("Space");
  assert.equal(await checkbox.getAttribute("aria-checked"), "true");
  const mentions = page.getByRole("radio", { name: "Mentions" });
  await mentions.focus();
  await page.keyboard.press("Space");
  assert.equal(await mentions.getAttribute("aria-checked"), "true");
  checks.push("checkboxAndRadioSupportKeyboardSelection");

  await page.getByText("Enabled", { exact: true }).click();
  await page.getByText("All messages", { exact: true }).click();
  assert.equal(await checkbox.getAttribute("aria-checked"), "false");
  assert.equal(await mentions.getAttribute("aria-checked"), "false");
  await page.locator("#reset-controls").click();
  assert.equal(await checkbox.getAttribute("aria-checked"), "true");
  assert.equal(await mentions.getAttribute("aria-checked"), "true");
  assert.deepEqual(await values(), { enabled: "on", mode: "mentions", title: "Draft", details: "Notes", choice: "first" });
  checks.push("nativeFormResetRestoresBaseControls");

  await page.getByText("Enabled", { exact: true }).click();
  await page.getByText("All messages", { exact: true }).click();
  await page.getByLabel("Title").fill("Keep draft");
  await page.evaluate(() => { window.controlsFixture.cancelReset = true; });
  await page.locator("#reset-controls").click();
  assert.equal(await checkbox.getAttribute("aria-checked"), "false");
  assert.equal(await mentions.getAttribute("aria-checked"), "false");
  assert.deepEqual(await values(), { mode: "all", title: "Keep draft", details: "Notes", choice: "first" });
  checks.push("canceledNativeResetKeepsVisibleAndSubmittedState");
  await page.evaluate(() => { window.controlsFixture.cancelReset = false; });
  await page.locator("#reset-controls").click();

  await page.locator("#toggle-disabled").click();
  assert.equal(await checkbox.getAttribute("aria-disabled"), "true");
  assert.equal(await mentions.getAttribute("aria-disabled"), "true");
  await checkbox.evaluate((element) => element.click());
  await page.getByRole("radio", { name: "All messages" }).evaluate((element) => element.click());
  assert.equal(await checkbox.getAttribute("aria-checked"), "true");
  assert.equal(await mentions.getAttribute("aria-checked"), "true");
  assert.deepEqual(await values(), {});
  checks.push("explicitDisabledStateBlocksPointerAndFormSubmission");
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ status: "passed", level: "real-chromium-base-ui-controls-fixture", checks, pageErrors, modelCalls: 0 }));
} finally {
  await browser?.close();
  await server.close();
  await rm(temporary, { recursive: true, force: true });
}
