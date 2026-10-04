/** Runtime transport confinement. Never changes the selected provider/model. */
let refusals = 0;
export function nativeMaintenanceRefusals() { return refusals; }
export function assertNativeMaintenanceInference(kind: 'chat' | 'tools' | 'expansion' | 'ocr', model?: string) {
  if (process.env.GBRAIN_NATIVE_MAINTENANCE !== '1') return;
  if (kind !== 'chat' || !/^codex:gpt-5\.6-(luna@low|sol@high)$/.test(model ?? '')) {
    refusals++;
    throw new Error('Native maintenance requires Mac text inference; configured provider or tool loop is unsupported');
  }
}
