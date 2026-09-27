// Only server-confirmed GitHub repository URLs may become clone commands.
export function agentRepositoryName(agent) {
  const name = String(agent?.name || agent?.id || "agent").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100).replace(/-+$/g, "");
  return name || "agent";
}

export function repositoryHandoff(url) {
  if (typeof url !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(url)) return null;
  const repository = url.split("/").at(-1);
  if (repository === "." || repository === ".." || repository.startsWith("-")) return null;
  return {
    url,
    actionsUrl: `${url}/actions`,
    commands: `git clone -- ${url}.git\ncd -- ${repository}`,
  };
}
