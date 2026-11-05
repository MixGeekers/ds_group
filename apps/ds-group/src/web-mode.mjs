export function parseWebMode(value = 'bundled') {
  if (!['bundled', 'api-only'].includes(value)) throw new Error('webMode / DS_GROUP_WEB_MODE must be bundled or api-only');
  return value;
}

export function effectiveWebMode(config, env = process.env) {
  // Compose passes an empty value when no deployment override is selected.
  return parseWebMode(env.DS_GROUP_WEB_MODE || config.webMode);
}
