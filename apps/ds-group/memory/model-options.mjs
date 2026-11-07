import {modelReference} from '../src/model-config.mjs';

// Custom DSH providers may expose a model without configurable thinking levels.
// An unsupported hard-coded effort fails before the provider receives a request.
export async function memoryModelOptions(llm,reference,signal){
  const route=modelReference(reference);
  const info=await llm.resolveModelInfo(route.provider,route.model,signal);
  return{...route,...(info?.reasoning?.efforts?.some(effort=>effort.id==='low')?{reasoningEffort:'low'}:{})};
}
