import {modelReference} from '../src/model-config.mjs';

// Importing offline checks never selects a paid provider. Live entry points
// require the caller's explicit reference and use that provider's own config.
export function memoryTestModel(value=process.env.DSCORD_MEMORY_TEST_MODEL||process.env.DS_GROUP_MODEL){
  if(value===undefined||value===null||value==='')throw Object.assign(new Error('Set DSCORD_MEMORY_TEST_MODEL or DS_GROUP_MODEL to your provider/model before running a live validation.'),{code:'TEST_MODEL_REQUIRED'});
  modelReference(value);
  return value;
}
export const MODEL=process.env.DSCORD_MEMORY_TEST_MODEL||process.env.DS_GROUP_MODEL||null;
export function verificationModel(value=MODEL,{run=false}={}){
  if(value===undefined||value===null||value==='')return run?memoryTestModel(null):null;
  return memoryTestModel(value);
}
export function restrictTestProvider(provider,reference=MODEL){
  const route=modelReference(memoryTestModel(reference)),copy=structuredClone(provider);
  if(copy.models?.length){copy.models=copy.models.filter(model=>model.id===route.model);if(copy.models.length!==1)throw new Error('TEST_MODEL_MISSING_FROM_PROFILE');}
  return copy;
}
export async function testModelSelection(llm,reference=MODEL){
  const route=modelReference(memoryTestModel(reference)),info=await llm.resolveModelInfo(route.provider,route.model);
  return{model:reference,maxTokens:4096,...(info?.reasoning?.efforts?.some(effort=>effort.id==='low')?{reasoningEffort:'low'}:{})};
}
