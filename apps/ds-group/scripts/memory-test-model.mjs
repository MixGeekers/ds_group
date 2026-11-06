import {modelReference} from '../src/model-config.mjs';

export const ORIGINAL_TEST_MODEL='opencode-go/deepseek-v4.1-flash';
export const COMMANDCODE_TEST_MODEL='commandcode-goat/deepseek/deepseek-v4.1-flash';
export function memoryTestModel(value=process.env.DSCORD_MEMORY_TEST_MODEL||ORIGINAL_TEST_MODEL){
  if(![ORIGINAL_TEST_MODEL,COMMANDCODE_TEST_MODEL].includes(value))throw new Error('TEST_MODEL_NOT_AUTHORIZED: use an explicitly authorized ordinary DeepSeek V4.1 Flash route; Fast is excluded');
  return value;
}
export const MODEL=memoryTestModel();
export function restrictTestProvider(provider,reference=MODEL){
  const route=modelReference(memoryTestModel(reference)),copy=structuredClone(provider);
  if(copy.models?.length){copy.models=copy.models.filter(model=>model.id===route.model);if(copy.models.length!==1)throw new Error('TEST_MODEL_MISSING_FROM_PROFILE');}
  return copy;
}
export async function testModelSelection(llm,reference=MODEL){
  const route=modelReference(memoryTestModel(reference)),info=await llm.resolveModelInfo(route.provider,route.model);
  return{model:reference,maxTokens:4096,...(info?.reasoning?.efforts?.some(effort=>effort.id==='low')?{reasoningEffort:'low'}:{})};
}
