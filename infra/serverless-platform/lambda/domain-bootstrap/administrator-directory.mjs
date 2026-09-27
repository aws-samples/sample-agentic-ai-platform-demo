import { ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { BootstrapError } from "./service.mjs";

// The platform currently supports exactly one permanent persona per user.
// Assigning domain ownership must not add a conflicting global persona.
export function administratorCandidate(user, groups) {
  const attribute = name => user.Attributes?.find(item => item.Name === name)?.Value;
  const roles = groups.filter(group => ["platform-admin", "domain-lead", "domain-builder", "end-user"].includes(group));
  const role = roles.length === 1 ? roles[0] : null;
  const enabled = user.Enabled === true;
  const eligible = enabled && ["platform-admin", "domain-lead"].includes(role);
  return {
    username: user.Username, subject: attribute("sub"), name: attribute("name") || user.Username,
    email: attribute("email") || "", enabled, eligible, role,
    reason: !enabled ? "Account disabled" : eligible ? ""
      : "Requires a Platform Admin or Domain Admin role; existing roles will not be changed.",
  };
}

export function createAdministratorDirectory({ cognito, userPoolId, groups }) {
  return async () => {
    const users = [], tokens = new Set();
    let PaginationToken;
    do {
      const page = await cognito.send(new ListUsersCommand({ UserPoolId: userPoolId, Limit: 60, PaginationToken }));
      if (!Array.isArray(page.Users)) throw new BootstrapError("DIRECTORY_UNAVAILABLE", "User directory is unavailable.", 503);
      users.push(...page.Users);
      PaginationToken = page.PaginationToken;
      if (users.length > 600 || (PaginationToken && tokens.has(PaginationToken))) {
        throw new BootstrapError("DIRECTORY_UNAVAILABLE", "The complete user directory could not be loaded.", 503);
      }
      if (PaginationToken) tokens.add(PaginationToken);
    } while (PaginationToken);
    const result = [];
    for (let index = 0; index < users.length; index += 4) {
      result.push(...await Promise.all(users.slice(index, index + 4).map(async user =>
        administratorCandidate(user, await groups(user.Username)))));
    }
    return result.sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.name.localeCompare(b.name));
  };
}
