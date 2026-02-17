export const reconcileElements = (
  localElements: readonly any[],
  remoteElements: readonly any[]
): any[] => {
  const localMap = new Map<string, any>();

  localElements.forEach((el) => {
    localMap.set(el.id, el);
  });

  const getVersion = (element: any) => element?.version ?? 0;
  const getVersionNonce = (element: any) => element?.versionNonce ?? 0;
  const getUpdated = (element: any) => {
    const value = element?.updated;
    return typeof value === "number" ? value : Number(value) || 0;
  };

  remoteElements.forEach((remoteEl) => {
    const localEl = localMap.get(remoteEl.id);

    if (!localEl) {
      localMap.set(remoteEl.id, remoteEl);
      return;
    }

    const remoteVersion = getVersion(remoteEl);
    const localVersion = getVersion(localEl);

    if (remoteVersion > localVersion) {
      localMap.set(remoteEl.id, remoteEl);
      return;
    }

    if (remoteVersion < localVersion) {
      return;
    }

    const remoteUpdated = getUpdated(remoteEl);
    const localUpdated = getUpdated(localEl);

    if (remoteUpdated > localUpdated) {
      localMap.set(remoteEl.id, remoteEl);
      return;
    }

    if (
      remoteUpdated === localUpdated &&
      getVersionNonce(remoteEl) !== getVersionNonce(localEl)
    ) {
      localMap.set(remoteEl.id, remoteEl);
    }
  });

  return Array.from(localMap.values());
};
