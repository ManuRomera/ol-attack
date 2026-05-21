const appv1 = globalThis.foundry?.appv1?.api ?? {};

export const LegacyApplication = globalThis.Application ?? appv1.Application;
export const LegacyFormApplication = globalThis.FormApplication ?? appv1.FormApplication;
export const LegacyDialog = globalThis.Dialog ?? appv1.Dialog;

export function ensureLegacyAppApi() {
  const missing = [];
  if (!LegacyApplication) missing.push('Application');
  if (!LegacyFormApplication) missing.push('FormApplication');
  if (!LegacyDialog) missing.push('Dialog');
  if (missing.length) {
    console.warn(`[ol-attack] Legacy app API missing: ${missing.join(', ')}`);
  }
  return { LegacyApplication, LegacyFormApplication, LegacyDialog };
}
