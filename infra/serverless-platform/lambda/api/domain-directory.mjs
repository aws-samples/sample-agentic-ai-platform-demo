function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (
      Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null
    ),
  );
}

function readOptions(options) {
  if (options === undefined) return undefined;
  const signalDescriptor = isPlainObject(options)
    ? Object.getOwnPropertyDescriptor(options, "abortSignal")
    : undefined;
  if (
    !isPlainObject(options)
    || Reflect.ownKeys(options).length !== 1
    || signalDescriptor === undefined
    || !Object.hasOwn(signalDescriptor, "value")
    || signalDescriptor.enumerable !== true
    || typeof AbortSignal !== "function"
    || !(signalDescriptor.value instanceof AbortSignal)
  ) {
    throw new TypeError("Domain directory options are invalid.");
  }
  return { abortSignal: signalDescriptor.value };
}

function validateDomainState(domainState, { requireGet = false } = {}) {
  if (
    !isPlainObject(domainState)
    || typeof domainState.listDomains !== "function"
    || (requireGet && typeof domainState.getDomain !== "function")
  ) {
    throw new TypeError("Domain directory configuration is invalid.");
  }
}

async function listActiveDomains(domainState, options) {
  const stateOptions = readOptions(options);
  const domains = await (
    stateOptions === undefined
      ? domainState.listDomains()
      : domainState.listDomains(stateOptions)
  );
  return domains.filter(({ status }) => status === "ACTIVE");
}

export function createActiveDomainDirectory(domainState) {
  validateDomainState(domainState);
  return Object.freeze({
    async listActiveDomains(options) {
      return (await listActiveDomains(domainState, options))
        .map(({ id }) => ({ id }));
    },
  });
}

export function createActiveDomainRecordDirectory(domainState) {
  validateDomainState(domainState, { requireGet: true });
  return Object.freeze({
    async getDomain(id, options) {
      const stateOptions = readOptions(options);
      return stateOptions === undefined
        ? domainState.getDomain(id)
        : domainState.getDomain(id, stateOptions);
    },
    async listActiveDomains(options) {
      return listActiveDomains(domainState, options);
    },
  });
}
