import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunDetail } from '../src/types';

const artifacts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../artifacts');

async function createFromUI(page: Page) {
  const response = page.waitForResponse(response => response.url().endsWith('/api/runs') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '开始实验', exact: true }).click();
  const created = await (await response).json() as { run: RunDetail };
  await expect(page.getByRole('tab', { name: '运行总览' })).toBeVisible();
  return created.run.id;
}

test('真实公司实验：空态、八项交付、预览下载、评分导入、运行对比和移动布局', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await mkdir(artifacts, { recursive: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '实验工作台', exact: true })).toBeVisible();
  await expect(page.locator('.history-empty')).toContainText('还没有运行记录');
  await expect(page.locator('.subject-card')).toHaveCount(8);
  await expect(page.locator('.scenario-card')).toHaveCount(4);
  await expect(page.locator('.person')).toHaveCount(15);
  await page.screenshot({ path: path.join(artifacts, 'lab-dashboard.png'), fullPage: true });

  const firstId = await createFromUI(page);
  await expect(page.locator('.scope-banner')).toContainText('参考执行器 · Lab 自检');
  await expect(page.locator('.run-title .badge')).toContainText('已完成', { timeout: 60000 });
  await expect(page.locator('.metrics-grid .metric').first()).toContainText('8 / 8');
  await expect(page.locator('.task-summary')).toHaveCount(8);
  await page.screenshot({ path: path.join(artifacts, 'lab-run.png'), fullPage: true });

  await page.getByRole('tab', { name: '信息流', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索事件' }).fill('经营');
  await expect(page.locator('.timeline-event').first()).toBeVisible();
  await page.getByRole('textbox', { name: '搜索事件' }).fill('no-match-experiment-123456');
  await expect(page.getByText('没有匹配的事件', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除', exact: true }).click();

  await page.getByRole('tab', { name: '交付产物' }).click();
  await expect(page.locator('.artifact-row')).toHaveCount(18);
  await page.locator('.artifact-main').filter({ hasText: 'result.json' }).first().click();
  await expect(page.locator('.file-preview')).toContainText('{');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: '下载 result.json', exact: true }).first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('result.json');
  expect(await download.failure()).toBeNull();

  await page.getByRole('tab', { name: '验收与评分' }).click();
  await expect(page.locator('.fact-summary')).toContainText('8 / 8');
  await expect(page.getByRole('button', { name: '运行 Agent 评审', exact: true })).toBeDisabled();
  await expect(page.getByRole('link', { name: '评审证据', exact: true })).toBeVisible();
  const packet = await (await request.get(`/api/runs/${firstId}/evidence`)).json();
  const validReview = {
    dimensions: [{ name: '交付可用性（测试导入）', status: 'scored', score: 4,
      reason: '本次导入仅验证评审链路，实际任务产物已由独立验收检查。', evidenceRefs: [packet.facts.assertions[0].id] }],
    needsHumanReview: false,
  };
  await page.getByRole('button', { name: '导入评分 JSON', exact: true }).click();
  await page.getByRole('textbox', { name: '评审 JSON', exact: true }).fill(JSON.stringify(validReview));
  await page.getByRole('button', { name: '导入并校验', exact: true }).click();
  await expect(page.locator('dialog')).not.toBeVisible();
  await expect(page.getByText('交付可用性（测试导入）', { exact: true })).toBeVisible();
  await expect(page.locator('.dimension-score')).toContainText('4');
  await page.locator('.review-card .evidence-links button').first().click();
  await expect(page.locator('.assertion[open]')).toHaveCount(1);

  await page.getByRole('button', { name: '导入评分 JSON', exact: true }).click();
  await page.getByRole('textbox', { name: '评审 JSON', exact: true }).fill(JSON.stringify({ dimensions: [{ name: '无效引用', status: 'scored', score: 5, reason: '测试拒绝', evidenceRefs: ['nonexistent-evidence'] }] }));
  await page.getByRole('button', { name: '导入并校验', exact: true }).click();
  await expect(page.locator('dialog')).not.toBeVisible();
  await expect(page.locator('.review-error')).toContainText('评审未完成');
  await expect(page.locator('.fact-summary')).toContainText('8 / 8');

  await page.getByRole('button', { name: '新实验', exact: true }).click();
  const secondId = await createFromUI(page);
  expect(secondId).not.toBe(firstId);
  await expect(page.locator('.run-title .badge')).toContainText('已完成', { timeout: 60000 });
  await page.getByRole('tab', { name: '实验对比' }).click();
  await page.getByLabel('选择对照运行').selectOption(firstId);
  await expect(page.locator('.comparison-note')).toContainText('场景、随机种子、负载和运行参数一致');
  await expect(page.locator('.comparison-table')).toContainText('8 / 8');

  await page.getByRole('button', { name: '新实验', exact: true }).click();
  await page.getByLabel('被测对象', { exact: true }).selectOption('external');
  await createFromUI(page);
  await expect(page.locator('.target-connection')).toContainText('Agent 接入令牌');
  await page.getByRole('tab', { name: '交付产物' }).click();
  await expect(page.getByText('等待第一份交付', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.locator('.run-title .badge')).toContainText('已停止');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('combobox', { name: '选择实验记录' })).toBeVisible();
  await page.getByRole('combobox', { name: '选择实验记录' }).selectOption(firstId);
  await expect(page.locator('.run-title .badge')).toContainText('已完成');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.getByRole('tab', { name: '工作任务', exact: true }).click();
  await expect(page.locator('.task-card')).toHaveCount(8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  expect(errors).toEqual([]);
});
