// Re-exports noVNC's RFB client as a browser ES module (the npm package only ships CommonJS).
import rfbModule from '@novnc/novnc/lib/rfb.js';

export default rfbModule.default ?? rfbModule;
