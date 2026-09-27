const TYPES = new Set(["Model", "Blueprint", "Skill", "MCPServer"]);
const text = value => typeof value === "string" && value.length > 0
  && value.length <= 512 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
export function validateProjectResourcePolicy(value) {
  if (value === null) return null; // Explicitly inherit the domain's current set.
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).join(",") !== "resources" || !Array.isArray(value.resources)
      || value.resources.length > 150) throw new Error("Project resource selection is invalid.");
  const seen = new Set();
  const resources = value.resources.map(ref => {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)
        || Object.keys(ref).some(key => !["type", "id", "registryId", "registryName"].includes(key))
        || !TYPES.has(ref.type) || !text(ref.id)
        || !(ref.registryId === null || text(ref.registryId))
        || (ref.registryName !== undefined && !text(ref.registryName))) {
      throw new Error("Project resource reference is invalid.");
    }
    const key = JSON.stringify([ref.type, ref.id, ref.registryId]);
    if (seen.has(key)) throw new Error("Project resource selection is duplicated.");
    seen.add(key);
    return { type: ref.type, id: ref.id, registryId: ref.registryId,
      ...(ref.registryName ? { registryName: ref.registryName } : {}) };
  });
  return { resources };
}
export function sameResource(left, right) {
  return left.type === right.type && left.registryId === right.registryId
    && (left.registryName && right.registryName
      ? left.registryName === right.registryName : left.id === right.id);
}
export function projectAllowsResource(project, type, id) {
  const policy = validateProjectResourcePolicy(project?.resourcePolicy ?? null);
  return policy === null || policy.resources.some(ref => ref.type === type && ref.id === id);
}
export function projectAllowsAgent(project, agent) {
  return projectAllowsResource(project, "Model", agent.modelId)
    && [["Blueprint", "blueprintIds"], ["Skill", "toolIds"], ["Skill", "skillIds"], ["MCPServer", "mcpServerIds"]]
      .every(([type, field]) => (agent[field] || []).every(id => projectAllowsResource(project, type, id)));
}
