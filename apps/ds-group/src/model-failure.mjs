// Exhausted account allowance is different from a transient rate limit.
export function isModelQuotaFailure(value) {
  return [value?.code,value?.errorCode,value?.nativeFailure?.code].some(code=>['QUOTA','MODEL_QUOTA_EXCEEDED'].includes(code))
    || /GoUsageLimitError/.test(typeof value==='string'?value:value?.message||'');
}
