function failed(response) {
  return response?.ok !== true;
}

function requireSuccess(response) {
  if (failed(response)) return response;
  return null;
}

export function activeBuildProjects(projects, domainId) {
  return (Array.isArray(projects) ? projects : []).filter(project =>
    project?.status === "ACTIVE"
    && (domainId === undefined || project.domainId === domainId));
}

function deploymentId(agentId, suffix) {
  const base = String(agentId || "agent");
  return `${base.slice(0, Math.max(1, 63 - suffix.length - 1))}-${suffix}`;
}

function agentConfiguration(agent = {}) {
  return {
    name: agent.name ?? "",
    description: agent.description ?? "",
    modelId: agent.modelId ?? "",
    toolIds: Array.isArray(agent.toolIds) ? agent.toolIds : [],
    mcpServerIds: Array.isArray(agent.mcpServerIds) ? agent.mcpServerIds : [],
    skillIds: Array.isArray(agent.skillIds) ? agent.skillIds : [],
    blueprintIds: Array.isArray(agent.blueprintIds) ? agent.blueprintIds : [],
    memoryIds: Array.isArray(agent.memoryIds) ? agent.memoryIds : [],
    knowledgeBaseIds: Array.isArray(agent.knowledgeBaseIds)
      ? agent.knowledgeBaseIds
      : [],
    buildConfig: agent.buildConfig ?? null,
  };
}

function sameAgentConfiguration(left, right) {
  return JSON.stringify(agentConfiguration(left))
    === JSON.stringify(agentConfiguration(right));
}

export function buildAgentInputError(agent) {
  if (typeof agent?.name !== "string" || !agent.name.trim()) {
    return "Enter an agent name.";
  }
  if (agent.name.length > 128 || /[\u0000-\u001f\u007f]/.test(agent.name)) {
    return "Agent name must be a single line of at most 128 characters.";
  }
  const instructions = agent.buildConfig?.instructions;
  if (typeof instructions !== "string" || !instructions.trim()) {
    return "Enter a persona / system prompt before generating your agent.";
  }
  if (instructions.length > 16384) {
    return "Persona / system prompt must be at most 16,384 characters.";
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(instructions)) {
    return "Persona / system prompt contains an unsupported control character.";
  }
  return null;
}

export function createMainUiBuildActions({ request, requestId } = {}) {
  if (typeof request !== "function" || typeof requestId !== "function") {
    throw new TypeError("Main UI build actions require request functions.");
  }

  const mutate = (path, body, options = {}) =>
    request(path, body, {
      method: "POST",
      ...options,
      requestId: requestId(),
    });

  async function inventory(path) {
    const items = [], seen = new Set();
    let cursor;
    do {
      const page = await request(path + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""));
      if (failed(page)) return page;
      if (!Array.isArray(page.items)) return { ok: false, code: "INVALID_INVENTORY", message: "Workspace inventory is unavailable. Retry before building." };
      items.push(...page.items);
      cursor = page.cursor;
      if (cursor && (typeof cursor !== "string" || seen.has(cursor) || seen.size >= 200)) {
        return { ok: false, code: "INVALID_INVENTORY", message: "Workspace inventory could not be fully loaded." };
      }
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { ok: true, items };
  }

  return {
    async prepareAgent({ project, agent }) {
      const inputError = buildAgentInputError(agent);
      if (inputError) return { ok: false, code: "INVALID_BUILD_INPUT", message: inputError };
      const projects = await inventory("/projects");
      if (requireSuccess(projects)) return projects;
      const existingProject = (projects.items || []).find((candidate) =>
        candidate.domainId === project.domainId
        && candidate.id === project.id);
      if (!existingProject || existingProject.status !== "ACTIVE") {
        return {
          ok: false,
          code: "PROJECT_NOT_AVAILABLE",
          message: existingProject?.status === "ARCHIVED"
            ? "This project has been archived. Choose an active project workspace before generating your Agent."
            : "Choose an active project workspace. Ask your Domain Lead to create one and assign you access.",
        };
      }

      const agents = await inventory("/agents");
      if (requireSuccess(agents)) return agents;
      let current = (agents.items || []).find((candidate) =>
        candidate.domainId === agent.domainId
        && candidate.projectId === agent.projectId
        && candidate.id === agent.id);
      if (!current) {
        const created = await mutate("/agents", agent);
        if (requireSuccess(created)) return created;
        current = created.agent;
      }
      if (
        current.status !== "DRAFT"
        && !sameAgentConfiguration(current, agent)
      ) {
        return {
          ok: false,
          code: "AGENT_CONFIGURATION_LOCKED",
          message:
            "This Agent ID already has a tested or deployed configuration. "
            + "Choose a new Agent ID to build a different version.",
        };
      }
      if (current.status === "DRAFT") {
        const configured = await mutate(
          `/agents/${encodeURIComponent(agent.id)}`,
          agent,
          { method: "PUT" },
        );
        if (requireSuccess(configured)) return configured;
        current = configured.agent;
      }
      return { ok: true, agent: current };
    },

    // 128 is the bounded-Converse ceiling (bedrock-inference validateModel);
    // anything above it is rejected as INVALID_BEDROCK_REQUEST → a misleading
    // "model test was rejected" even though the configuration is fine.
    testAgent(ref, prompt, maxTokens = 128) {
      return mutate(
        `/agents/${encodeURIComponent(ref.agentId)}/test`,
        {
          domainId: ref.domainId,
          projectId: ref.projectId,
          prompt,
          maxTokens,
        },
      );
    },

    publishAgent(ref) {
      return mutate("/governance/agent-publications", ref);
    },

    deploySandbox(ref) {
      return mutate("/deployments/sandbox", {
        ...ref,
        deploymentId: deploymentId(ref.agentId, "sandbox"),
      });
    },

    submitProduction(ref) {
      return mutate("/deployments/production", {
        ...ref,
        deploymentId: deploymentId(ref.agentId, "production"),
        approvalId: deploymentId(ref.agentId, "production-approval"),
      });
    },

    previewFull(ref, repositoryName, evaluation) {
      return mutate("/delivery/previews", {
        preset: "FULL",
        ...(evaluation ? {evaluation} : {}),
        repositoryName,
        projectId: ref.projectId,
        agentId: ref.agentId,
      });
    },

    async previewFoundation(repositoryName) {
      const started = await mutate("/journeys", {
        preset: "MINIMAL",
        repositoryName,
      });
      if (requireSuccess(started)) return started;
      return mutate("/delivery/previews", {
        preset: "MINIMAL",
        repositoryName,
        journeyId: started.journey.id,
      });
    },

    startSpec(repositoryName) {
      return mutate("/journeys", {
        preset: "SPEC",
        repositoryName,
      });
    },

    addSpecMessage(journeyId, text) {
      return mutate(
        `/journeys/${encodeURIComponent(journeyId)}/messages`,
        { text },
      );
    },

    createSpecContract(journeyId) {
      return mutate(
        `/journeys/${encodeURIComponent(journeyId)}/contract`,
        {},
      );
    },

    previewSpec(ref, repositoryName, journeyId) {
      return mutate("/delivery/previews", {
        preset: "SPEC",
        repositoryName,
        journeyId,
        projectId: ref.projectId,
        agentId: ref.agentId,
      });
    },

    authorizeGitHub(delivery) {
      return mutate("/delivery/github/authorizations", {
        previewId: delivery.id,
        fingerprint: delivery.manifest.fingerprint,
        confirmation: delivery.repositoryName,
        acknowledgePrivateRepository: true,
      });
    },
  };
}
