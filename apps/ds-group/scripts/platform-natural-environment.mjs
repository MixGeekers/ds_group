import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildNaturalCorpus, publicCorpusSummary } from './platform-natural-corpus.mjs';
import { MODEL } from './memory-test-model.mjs';

export function naturalEnvironmentProfiles(profile) {
  const { people } = buildNaturalCorpus(profile);
  return [people.find(person => person.key === 'd'), ...people.filter(person => person.key !== 'd')].map(person => [person.localpart, person.name]);
}
export function naturalEnvironmentModelSettings(profile) {
  return { allowedModels: [MODEL], model: MODEL, plannedRounds: buildNaturalCorpus(profile).steps.length };
}

// Explicit service preparation, separate from any provider/model execution.
export async function startNaturalEnvironment({ profile = 'diagnostic', port, matrixPort } = {}) {
  const corpus = buildNaturalCorpus(profile), summary = publicCorpusSummary(corpus);
  const { startVisibleEnvironment } = await import('./memory-visible-environment.mjs');
  const state = await startVisibleEnvironment({ port: port || (profile === 'diagnostic' ? 25340 : 25350),
    matrixPort: matrixPort || (profile === 'diagnostic' ? 25348 : 25358),
    serverName: `natural-${profile}.local`, prefix: `platform-natural-${profile}`,
    activeFile: `platform-natural-${profile}-active.json`,
    profiles: naturalEnvironmentProfiles(profile),
    ...naturalEnvironmentModelSettings(profile),
    preparingMessage: `自然生活与工作对话准备中。${summary.participants}位合成人类角色、${summary.bots}个独立Bot；业务时间是剧本时间，实际运行时间另行记录。场景消息与真实Bot工作稍后开始。` });
  return { ...state, naturalProfile: profile, plannedMessages: corpus.steps.length };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length && !['diagnostic', 'full'].includes(args[0])) throw new Error('Use: node scripts/platform-natural-environment.mjs [diagnostic|full]');
  console.log(JSON.stringify(await startNaturalEnvironment({ profile: args[0] || 'diagnostic' }), null, 2));
}
