// Declarations for the type checker (npm run typecheck): what the page, the browser or
// the userscript manager provide that TypeScript's DOM types do not know.

declare const Hls: any;                 // hls.js, loaded by the userscript manager (@require)
declare const GM_info: any;             // the userscript manager's script info
declare const VERSION: string;          // set by build.mjs around the joined sources
declare const webkitAudioContext: typeof AudioContext;

interface Window {
  Hls?: any;
  Echo?: any;                           // Echo360's page object (10-adapter-echo360.js)
  webkitAudioContext?: typeof AudioContext;
  webkitOfflineAudioContext?: typeof OfflineAudioContext;
  documentPictureInPicture?: { requestWindow(opts?: { width?: number; height?: number }): Promise<Window> };
  __litePlayerForEcho360DryRun?: object[];       // development: writes recorded instead of sent
  __litePlayerForEcho360?: object;         // development (debug on)
  __litePlayerForEcho360Dev?: object;            // development (debug on)
}

interface Navigator {
  connection?: { downlink?: number; saveData?: boolean };
}
