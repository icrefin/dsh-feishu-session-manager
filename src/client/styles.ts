/**
 * The settings page's stylesheet.
 *
 * Every color is a `--dsw-alias-*` theme token, never a literal, so light and
 * dark both work and a renamed token degrades instead of breaking. The tag is
 * created from the bundle's own factory body, so the client module system claims
 * it and removes it when the plugin is disabled.
 *
 * Class names carry the `dfsm-` prefix, derived from the plugin id, so two
 * plugins cannot collide.
 *
 * @module dsh-feishu-session-manager/client/styles
 */

/** Id of the stylesheet tag, so injection stays idempotent. */
export const STYLE_ID = 'dsh-feishu-session-manager-style'

/** Theme-token-only stylesheet for the settings page. */
export const SECTION_CSS = `
.dfsm-page{display:flex;flex-direction:column;gap:18px;padding:4px 2px 32px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}
.dfsm-head{display:flex;flex-direction:column;gap:6px}
.dfsm-head-line{display:flex;align-items:baseline;flex-wrap:wrap}
.dfsm-title{margin:0;font-size:18px;font-weight:600;line-height:1.35}
.dfsm-credit{color:var(--dsw-alias-label-caption);font-size:12px;font-weight:500;margin-left:6px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dfsm-description{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;max-width:70ch}
.dfsm-group{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.dfsm-group-head{display:flex;flex-direction:column;gap:4px}
.dfsm-group-title{margin:0;font-size:14px;font-weight:600}
.dfsm-group-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;max-width:72ch}
.dfsm-row{display:grid;grid-template-columns:minmax(130px,180px) minmax(0,1fr);gap:6px 16px;align-items:start}
.dfsm-label{color:var(--dsw-alias-label-primary);font-size:13px;padding-top:6px}
.dfsm-control{display:flex;flex-direction:column;gap:4px;min-width:0}
.dfsm-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.dfsm-input,.dfsm-select,.dfsm-textarea{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:6px 10px;min-width:0}
.dfsm-input:focus,.dfsm-select:focus,.dfsm-textarea:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-color:transparent}
.dfsm-textarea{min-height:130px;resize:vertical;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,monospace);font-size:12px;line-height:1.55}
.dfsm-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dfsm-button{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:5px 12px;cursor:pointer}
.dfsm-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dfsm-button:disabled{opacity:.55;cursor:default}
.dfsm-button-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dfsm-button-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dfsm-switch{position:relative;width:38px;height:21px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;padding:0;flex:none}
.dfsm-switch::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:var(--dsw-alias-switch-thumb,var(--dsw-alias-label-secondary));transition:transform .15s ease}
.dfsm-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:transparent}
.dfsm-switch[aria-checked="true"]::after{transform:translateX(17px);background:var(--dsw-alias-label-primary-foreground)}
.dfsm-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
.dfsm-dot[data-state="connected"]{background:var(--dsw-alias-state-success-primary)}
.dfsm-dot[data-state="connecting"],.dfsm-dot[data-state="reconnecting"]{background:var(--dsw-alias-state-warn-primary)}
.dfsm-dot[data-state="failed"],.dfsm-dot[data-state="error"]{background:var(--dsw-alias-state-error-primary)}
.dfsm-badge{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dfsm-metrics{display:flex;flex-wrap:wrap;gap:8px 18px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dfsm-metrics b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums}
.dfsm-log{margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);max-height:200px;overflow:auto;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,monospace);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.dfsm-log-line{color:var(--dsw-alias-label-secondary)}
.dfsm-log-line[data-level="warn"]{color:var(--dsw-alias-state-warn-primary)}
.dfsm-log-line[data-level="error"]{color:var(--dsw-alias-state-error-primary)}
.dfsm-pending{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.dfsm-pending li{border-left:2px solid var(--dsw-alias-brand-primary);padding-left:10px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dfsm-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
.dfsm-ok{color:var(--dsw-alias-state-success-primary);font-size:12px}
.dfsm-footer{display:flex;gap:10px;align-items:center;flex-wrap:wrap;position:sticky;bottom:0;padding:10px 0;background:linear-gradient(to top,var(--dsw-alias-bg-layer-1),transparent)}
.dfsm-route-result{margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,monospace);font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}
`

/** Append the stylesheet once per document. */
export function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = SECTION_CSS
  document.head.append(style)
}