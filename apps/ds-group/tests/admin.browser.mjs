import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";
import { createAdmin } from "../src/admin.mjs";
import { packageRoot } from "../src/paths.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "dscord-admin-browser-"));
const invitations = [];
const admin = await createAdmin({
  dataRoot: root,
  setup: {
    serverName: "home.test",
    homeserverUrl: "http://127.0.0.1:1",
    roomId: "!main:home.test",
    participants: [],
  },
  controlFactory: ({ governance }) => ({
    status: async () => ({
      savedRevision: (await governance.read()).revision,
      livePolicyObserved: false,
      restartRequired: true,
      configurationWritable: false,
      guard: null,
      application: null,
    }),
    apply: async () => ({
      savedRevision: (await governance.read()).revision,
      livePolicyObserved: false,
      restartRequired: true,
      configurationWritable: false,
      guard: null,
      application: {
        revision: (await governance.read()).revision,
        status: "partial",
        configuration: {
          status: "failed",
          error: "Synthetic service fixture: Synapse not running",
        },
        rooms: [],
      },
    }),
    invite: async (input) => { invitations.push(input); return { event_id: "$synthetic-invite" }; },
  }),
});
await admin.auth.change(
  "test-console",
  {
    username: "admin",
    password: "synthetic-browser-password",
    role: "owner",
    enabled: true,
  },
  { bootstrap: true },
);
await new Promise((resolve) => admin.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${admin.server.address().port}`;
const checks = [];
const errors = [];
let browser;
let failure;
const output = path.join(packageRoot, ".local/admin-consistency-review");
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "capture-origin.json"), JSON.stringify({ base, synthetic: true, transient: true }, null, 2) + "\n");
try {
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: "en-US",
  });
  await context.addInitScript(() => {
    localStorage.setItem("ds-group.language", "en");
    localStorage.setItem("ds-group.theme", "light");
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.screenshot({ path: path.join(output, "admin-login-desktop.png"), animations: "disabled" });
  await page.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await page.getByLabel("管理员账号", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("incorrect-browser-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("alert").getByText("管理员账号或密码错误。", { exact: true }).waitFor();
  await page.getByLabel("语言", { exact: true }).selectOption("en");
  await page.getByRole("alert").getByText("Administrator name or password is incorrect.", { exact: true }).waitFor();
  checks.push("Known login errors follow the active language, including a language change after failure");
  await page.getByLabel("Administrator", { exact: true }).fill("admin");
  await page
    .getByLabel("Password", { exact: true })
    .fill("synthetic-browser-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  checks.push(
    "Independent management login reaches the real administration HTTP service",
  );
  await page
    .getByRole("button", { name: "Partner servers", exact: true })
    .click();
  await page.getByText("Changes are staged. Save the policy, then prepare and apply it.", { exact: true }).waitFor();
  const [actualBorder, expectedBorder] = await page.getByLabel("Display name", { exact: true }).evaluate((input) => {
    const probe = document.createElement("span");
    probe.style.border = "1px solid var(--color-border-normal)";
    document.body.append(probe);
    const colors = [getComputedStyle(input).borderTopColor, getComputedStyle(probe).borderTopColor];
    probe.remove();
    return colors;
  });
  assert.equal(actualBorder, expectedBorder);
  await page.getByLabel("Display name", { exact: true }).fill("Partner B");
  await page
    .getByLabel("Matrix server name", { exact: true })
    .fill("partner.test");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByText("Unsaved changes", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Save policy", exact: true }).click();
  await page.getByText("Saved revision 1", { exact: true }).waitFor();
  assert.equal(
    (await admin.governance.read()).partners[0].serverName,
    "partner.test",
  );
  checks.push(
    "Partner form persists an explicit domain and updates the revision",
  );
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.locator(".admin-confirm").getByText("Remove this entry from the draft policy?", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.getByText("Unsaved changes", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  assert.equal(await page.getByLabel("Display name", { exact: true }).inputValue(), "Partner B");
  await page.getByRole("checkbox", { name: "Enabled", exact: true }).click();
  assert.equal(await page.getByRole("checkbox", { name: "Enabled", exact: true }).getAttribute("aria-checked"), "false");
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.screenshot({ path: path.join(output, "admin-remove-confirm-desktop.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Confirm removal", exact: true }).click();
  await page.getByRole("heading", { name: "Add entry", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Display name", { exact: true }).inputValue(), "");
  assert.equal(await page.getByLabel("Matrix server name", { exact: true }).inputValue(), "");
  assert.equal(await page.getByRole("checkbox", { name: "Enabled", exact: true }).getAttribute("aria-checked"), "true");
  assert.equal(await page.locator(".admin-list-row").count(), 0);
  assert.equal((await admin.governance.read()).partners.length, 1);
  await page.getByText("Unsaved changes", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Administrators", exact: true }).click();
  await page.getByRole("button", { name: "Open policy", exact: true }).click();
  await page.getByRole("heading", { name: "Partner servers", exact: true }).waitFor();
  await page.getByRole("button", { name: "Discard changes and reload", exact: true }).click();
  await page.getByText("Saved revision 1", { exact: true }).waitFor();
  checks.push("Removing the record being edited clears uncontrolled fields and restores defaults while staging deletion across sections");
  await page.getByRole("button", { name: "Admission", exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill("Bob");
  await page
    .getByLabel("Full Matrix ID", { exact: true })
    .fill("@bob-with-a-very-long-identity-for-cross-server-collaboration:partner.test");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Save policy", exact: true }).click();
  await page.getByText("Saved revision 2", { exact: true }).waitFor();
  assert.equal(await page.locator(".admin-section-layout > .admin-list-panel").count(), 1);
  assert.equal(await page.locator(".admin-section-layout > .admin-editor").count(), 1);
  const [listBox, editorBox] = await Promise.all([
    page.locator(".admin-list-panel").boundingBox(),
    page.locator(".admin-editor").boundingBox(),
  ]);
  assert.ok(listBox && editorBox && editorBox.x > listBox.x + listBox.width);
  checks.push(
    "Admission keeps the external member’s complete original Matrix ID",
  );
  await page.screenshot({ path: path.join(output, "admin-admission-desktop-long-id-en.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const nav = document.querySelector('.admin-sidebar nav');
    const active = nav.querySelector('[aria-current="page"]');
    const item = active.getBoundingClientRect();
    const frame = nav.getBoundingClientRect();
    return item.left >= frame.left && item.right <= frame.right;
  });
  await page.screenshot({ path: path.join(output, "admin-admission-mobile-long-id-en.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  checks.push("Admission list and editor align as columns on desktop; long Matrix ID fits mobile viewport");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Room rules", exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill("Shared room");
  await page
    .getByLabel("Matrix room ID", { exact: true })
    .fill("!main:home.test");
  await page
    .getByLabel("Approved member IDs, one per line")
    .fill("@bob-with-a-very-long-identity-for-cross-server-collaboration:partner.test");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Save policy", exact: true }).click();
  await page.getByText("Saved revision 3", { exact: true }).waitFor();
  checks.push(
    "Room rule binds one approved identity to an explicit authority and room",
  );
  await page.getByRole("button", { name: "Invite approved member", exact: true }).click();
  await page.getByText("Invitation submitted", { exact: true }).waitFor();
  assert.equal(invitations.length, 1);
  assert.deepEqual(invitations, [{ roomId: "!main:home.test", memberId: "@bob-with-a-very-long-identity-for-cross-server-collaboration:partner.test", revision: 3 }]);
  checks.push("Shared button submits an approved room invitation to the real administration API");
  await page.getByRole("button", { name: "Bot work", exact: true }).click();
  await page
    .getByLabel("Full Matrix ID", { exact: true })
    .fill("@worker:home.test");
  await page
    .getByLabel("Allowed room IDs, one per line")
    .fill("!main:home.test");
  await page
    .getByLabel("Allowed task requesters, one per line")
    .fill("@bob-with-a-very-long-identity-for-cross-server-collaboration:partner.test");
  for (const tool of ["read", "write", "edit", "read_image"])
    await page.getByRole("checkbox", { name: tool, exact: true }).click();
  assert.equal(await page.locator('input[name="canDelegate"]').count(), 0);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Save policy", exact: true }).click();
  await page.getByText("Saved revision 4", { exact: true }).waitFor();
  assert.deepEqual((await admin.governance.read()).botPolicies[0], {
    botId: "@worker:home.test",
    enabled: true,
    roomIds: ["!main:home.test"],
    requesterIds: ["@bob-with-a-very-long-identity-for-cross-server-collaboration:partner.test"],
    tools: ["read", "write", "edit", "read_image"],
    canDelegate: false,
  });
  checks.push(
    "Bot ceiling form saves exact home Bot, room, requester and four supported file tools without offering delegation",
  );
  await admin.governance.save(await admin.governance.read());
  await page
    .getByLabel("Full Matrix ID", { exact: true })
    .fill("@second:home.test");
  await page
    .getByLabel("Allowed room IDs, one per line")
    .fill("!main:home.test");
  await page
    .getByLabel("Allowed task requesters, one per line")
    .fill("@bob-with-a-very-long-identity-for-cross-server-collaboration:partner.test");
  await page.getByRole("checkbox", { name: "read", exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Save policy", exact: true }).click();
  await page
    .getByRole("alert")
    .getByText("Policy changed; reload before saving", { exact: true })
    .waitFor();
  assert.equal((await admin.governance.read()).botPolicies.length, 1);
  await page
    .getByRole("button", { name: "Discard changes and reload", exact: true })
    .click();
  await page.getByText("Saved revision 5", { exact: true }).waitFor();
  checks.push(
    "Stale policy CAS is rejected and explicit discard/reload restores the current server revision",
  );
  await page.screenshot({
    path: path.join(output, "bot-admin-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Prepare and apply", exact: true })
    .click();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page
    .getByText("Synthetic service fixture: Synapse not running")
    .waitFor();
  await page.screenshot({ path: path.join(output, "admin-application-error-desktop.png"), animations: "disabled" });
  assert.equal(
    await page.getByText("Live policy observed", { exact: true }).count(),
    0,
  );
  checks.push(
    "Failed application is visible and does not claim a live policy or completed federation restart",
  );
  await page.getByRole("button", { name: "Deployment", exact: true }).click();
  await page.screenshot({ path: path.join(output, "admin-deployment-desktop.png"), animations: "disabled" });
  await page
    .getByLabel("Local registration", { exact: true })
    .selectOption("closed");
  await page.getByLabel("Attachment limit (MiB)", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Save policy", exact: true }).click();
  await page.getByText("Saved revision 6", { exact: true }).waitFor();
  assert.deepEqual((await admin.governance.read()).settings, {
    registrationMode: "closed",
    maxUploadBytes: 2097152,
  });
  checks.push("Deployment controls persist registration and upload policy");
  await page.getByRole("button", { name: "Prepare and apply", exact: true }).click();
  await page.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await page.getByRole("button", { name: "概览", exact: true }).click();
  await page.getByText("部分应用", { exact: true }).waitFor();
  await page.getByLabel("语言", { exact: true }).selectOption("en");
  checks.push("Chinese overview localizes the observed partial application state");
  await page
    .getByRole("button", { name: "Administrators", exact: true })
    .click();
  await page.getByRole("button", { name: "Open policy", exact: true }).waitFor();
  checks.push("Pending federation application has a compact route back to policy controls");
  await page.screenshot({ path: path.join(output, "admin-administrators-desktop.png"), animations: "disabled" });
  await page.getByRole("checkbox", { name: "Enabled", exact: true }).click();
  assert.equal(await page.getByRole("checkbox", { name: "Enabled", exact: true }).getAttribute("aria-checked"), "false");
  await page.locator("form.admin-editor").evaluate((form) => form.reset());
  await page.waitForFunction(() => document.querySelector('form.admin-editor [role="checkbox"]')?.getAttribute('aria-checked') === 'true');
  assert.equal(await page.getByRole("checkbox", { name: "Enabled", exact: true }).getAttribute("aria-checked"), "true");
  await page.getByLabel("Administrator", { exact: true }).fill("auditor");
  await page.getByLabel("Role", { exact: true }).selectOption("auditor");
  await page
    .getByLabel("New password (12+ characters; leave empty to keep)")
    .fill("synthetic-auditor-password");
  await page
    .getByRole("button", { name: "Save administrator", exact: true })
    .click();
  await page.getByText("auditor", { exact: true }).first().waitFor();
  assert.equal(await page.getByRole("checkbox", { name: "Enabled", exact: true }).getAttribute("aria-checked"), "true");
  checks.push("Owner can create an independent read-only administrator");
  await page.getByRole("button", { name: "Audit", exact: true }).click();
  await page.getByRole("button", { name: "Open policy", exact: true }).click();
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await page.getByRole("button", { name: "Audit", exact: true }).click();
  await page.getByText("policy.save", { exact: true }).first().waitFor();
  assert.equal(
    await page
      .getByText("synthetic-browser-password", { exact: false })
      .count(),
    0,
  );
  checks.push("Audit shows actual administrative writes without credentials");
  await page.getByLabel("Language", { exact: true }).selectOption("zh-CN");
  await page.getByRole("heading", { name: "审计", exact: true }).waitFor();
  await page.getByText("admin · 所有者", { exact: true }).waitFor();
  await page.getByLabel("外观", { exact: true }).selectOption("dark");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  checks.push(
    "Chinese translation and dark appearance use shared preferences and tokens",
  );
  await page.getByRole("button", { name: "伙伴服务器", exact: true }).click();
  await page.getByText("修改先暂存；保存策略后，再准备并应用。", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const nav = document.querySelector('.admin-sidebar nav');
    const active = nav.querySelector('[aria-current="page"]');
    const item = active.getBoundingClientRect();
    const frame = nav.getBoundingClientRect();
    return item.left >= frame.left && item.right <= frame.right;
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: path.join(output, "admin-mobile.png"),
    fullPage: true,
  });
  checks.push(
    "Mobile management forms fit a 390px viewport without page overflow",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel("外观", { exact: true }).selectOption("light");
  await page.screenshot({
    path: path.join(output, "admin-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "退出管理", exact: true }).click();
  await page.getByLabel("管理员账号", { exact: true }).fill("auditor");
  await page
    .getByLabel("密码", { exact: true })
    .fill("synthetic-auditor-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "概览", exact: true }).waitFor();
  await page.getByText("auditor · 审计员", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "保存策略", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "伙伴服务器", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "添加", exact: true }).count(),
    0,
  );
  assert.equal(await page.locator(".admin-section-layout.is-single").count(), 1);
  await page.getByRole("button", { name: "管理员", exact: true }).click();
  assert.equal(await page.locator(".admin-section-layout.is-single").count(), 1);
  await page.getByRole("button", { name: "Bot 工作", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "添加", exact: true }).count(),
    0,
  );
  assert.equal(await page.locator('input[name="canDelegate"]').count(), 0);
  checks.push("Auditor login hides all policy mutation controls");
  await admin.auth.change("test-console", {
    username: "auditor",
    role: "auditor",
    enabled: true,
  });
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await page.getByRole("heading", { name: "管理员登录", exact: true }).waitFor();
  await page.getByRole("alert").getByText("管理员会话已过期，请重新登录。", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, "admin-session-expired-zh.png"), animations: "disabled" });
  checks.push("Revoked real administrator session returns to Chinese login with a localized expiration error");
  const requiredContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await requiredContext.addInitScript(() => {
    localStorage.setItem("ds-group.language", "zh-CN");
    sessionStorage.setItem(`dscord.management.${location.origin}`, JSON.stringify({
      access_token: "not-an-admin-token",
      administrator: { username: "synthetic", role: "owner" },
      expiresAt: Date.now() + 60000,
    }));
  });
  const requiredPage = await requiredContext.newPage();
  requiredPage.on("pageerror", (error) => errors.push(error.message));
  await requiredPage.goto(base);
  await requiredPage.getByRole("heading", { name: "管理员登录", exact: true }).waitFor();
  await requiredPage.getByRole("alert").getByText("请使用本服务器的管理员账号登录。", { exact: true }).waitFor();
  await requiredPage.screenshot({ path: path.join(output, "admin-session-required-zh.png"), animations: "disabled" });
  await requiredContext.close();
  checks.push("Unauthenticated management session shows the localized required-session error");
  assert.deepEqual(errors, []);
  checks.push("No browser runtime errors");
} catch (error) {
  failure = error;
} finally {
  await browser?.close();
  await admin.close();
  await rm(root, { recursive: true, force: true });
  await writeFile(
    path.join(output, "admin-browser.json"),
    JSON.stringify(
      {
        scope:
          "real management service and built UI; synthetic Matrix control adapter; zero model calls",
        checks,
        errors,
        status: failure ? "failed" : "passed",
        ...(failure ? { failure: String(failure.stack || failure) } : {}),
      },
      null,
      2,
    ),
  );
}
if (failure) throw failure;
console.log(JSON.stringify({ checks: checks.length, status: "passed" }));
