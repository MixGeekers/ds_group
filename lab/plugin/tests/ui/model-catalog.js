// Synthetic metadata only. The harness has no inference implementation or credentials.
export const modelCatalog = {
  groups: [{ id: 'synthetic', name: '合成宿主提供方', models: [
    { id: 'reasoner', name: '合成推理模型', reasoning: { defaultEffort: 'balanced', efforts: [{ id: 'balanced', name: '标准思考' }, { id: 'deep', name: '深入思考' }] } },
    { id: 'plain', name: '合成普通模型' },
  ] }], failures: [], default: { provider: 'synthetic', model: 'reasoner' },
};
export function resolveModel(selection) {
  const model = modelCatalog.groups.find(group => group.id === selection.provider)?.models.find(model => model.id === selection.model);
  if (!model) throw new Error('Unknown synthetic model');
  if (selection.reasoningEffort && !model.reasoning?.efforts.some(level => level.id === selection.reasoningEffort)) throw new Error('Unknown synthetic reasoning effort');
  return { ...selection, ...(model.reasoning && !selection.reasoningEffort ? { reasoningEffort: model.reasoning.defaultEffort } : {}) };
}
