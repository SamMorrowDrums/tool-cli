const UNKNOWN = "unknown";

export function classifyDockerOwnershipModel(rawSecurityOptions) {
  let securityOptions;
  try {
    securityOptions = JSON.parse(rawSecurityOptions);
  } catch {
    return UNKNOWN;
  }

  if (!Array.isArray(securityOptions) || securityOptions.length === 0) {
    return UNKNOWN;
  }

  const names = new Set();
  for (const option of securityOptions) {
    if (typeof option !== "string") return UNKNOWN;

    const nameField = option.split(",", 1)[0];
    const match = /^name=([a-z0-9][a-z0-9_-]*)$/i.exec(nameField);
    if (!match) return UNKNOWN;
    names.add(match[1].toLowerCase());
  }

  const rootless = names.has("rootless");
  const remappedUserNamespace = names.has("userns");
  if (rootless) return "rootless";
  if (remappedUserNamespace) return "userns-remap";
  return "rootful";
}
