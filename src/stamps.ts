/**
 * Shared stamp utilities for Leaflet WebView maps.
 * Provides JS generation for injecting/removing stamp markers,
 * and a default emoji palette.
 */

import type { MapStamp } from './types';

export const STAMP_EMOJIS = ['🏠', '❤️', '⭐', '🏢', '🎓', '🏥', '🛒', '📍'];

/** Generate JS to inject all stamps into the map's _stampLayer. */
export function buildStampsLayerJS(stamps: MapStamp[]) {
  const markersJS = stamps
    .map((st) => {
      const safeEmoji = st.emoji.replace(/'/g, "\\'");
      const safeName = st.name.replace(/'/g, "\\'");
      const svg = `<div style="text-align:center;line-height:1;"><div style="font-size:22px;">${safeEmoji}</div><div style="font-size:9px;color:#FFF;text-shadow:0 0 4px rgba(0,0,0,0.9);white-space:nowrap;margin-top:1px;">${safeName}</div></div>`;
      const icon = `L.divIcon({html:'${svg.replace(/'/g, "\\'")}',className:'stamp-pin',iconSize:[60,36],iconAnchor:[30,18]})`;
      return `(function(){var m=L.marker([${st.lat},${st.lng}],{icon:${icon},zIndexOffset:500}).addTo(window._stampLayer);m.on('click',function(){window.ReactNativeWebView.postMessage(JSON.stringify({type:'stampTap',id:'${st.id}',name:'${safeName}'}));});})();`;
    })
    .join('\n');

  return `
    if(!window._stampLayer){window._stampLayer=L.layerGroup().addTo(map);}
    window._stampLayer.clearLayers();
    ${markersJS}
    true;
  `;
}
