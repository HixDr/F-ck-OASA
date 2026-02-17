/**
 * Shared Leaflet map HTML generator.
 * Produces a dark-themed WebView HTML with metro lines, long-press handler,
 * cat icon user marker, and all shared layer groups.
 */

import { METRO_LINES } from './metro';

export function buildBaseMapHTML(
  center: [number, number],
  zoom: number,
  userMarkerSrc: string,
) {
  // Build 3 shared divIcon instances (one per metro line color)
  const lineEntries = Object.values(METRO_LINES);
  const metroIconsJS = lineEntries
    .map((line) => {
      const mSvg = `<svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg"><circle cx="9" cy="9" r="8" fill="${line.color}" fill-opacity="0.45" stroke="#FFF" stroke-width="1" stroke-opacity="0.4"/><text x="9" y="13" text-anchor="middle" fill="#FFF" fill-opacity="0.7" font-size="11" font-weight="bold" font-family="Arial,sans-serif">M</text></svg>`;
      const safeHtml = mSvg.replace(/'/g, "\\'");
      return `var _mIcon_${line.color.slice(1)}=L.divIcon({html:'${safeHtml}',className:'metro-pin',iconSize:[18,18],iconAnchor:[9,9]});`;
    })
    .join('\n');

  // Metro polyline coords + station data (all objects created lazily by toggleMetro)
  const metroDataJS = lineEntries
    .map((line) => {
      const coords = line.stations.map((s) => s.c);
      const coordsJson = JSON.stringify(coords);
      const stationData = line.stations
        .map((s) => {
          const safeName = s.n.replace(/'/g, "\\'");
          return `metroStations.push({lat:${s.c[0]},lng:${s.c[1]},name:'${safeName}',icon:_mIcon_${line.color.slice(1)}});`;
        })
        .join('\n');
      return `metroPolyData.push({coords:${coordsJson},color:'${line.color}'});\n${stationData}`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  * { margin: 0; padding: 0; }
  html, body, #map { width: 100%; height: 100%; background: #3a3a3a; }
  .leaflet-tile-pane { opacity: 0.75; }
  .leaflet-popup-content-wrapper { background: #0F0814; color: #FFFFFF; border: 1px solid #2D1B4E; border-radius: 8px; }
  .leaflet-popup-tip { background: #0F0814; }
  .leaflet-control-zoom a { background: #0F0814 !important; color: #FFFFFF !important; border-color: #2D1B4E !important; }
  .leaflet-control-attribution { display: none; }
  .bus-pin { background: none !important; border: none !important; }
  .stop-pin { background: none !important; border: none !important; }
  .metro-pin { background: none !important; border: none !important; }
  .user-marker { background: none !important; border: none !important; }
  .stamp-pin { background: none !important; border: none !important; }
  .metro-label { background: transparent !important; color: #FFF !important; border: none !important; border-radius: 0 !important; padding: 0 2px !important; font-size: 11px !important; font-weight: 600 !important; box-shadow: none !important; white-space: nowrap !important; text-shadow: 0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.6); }
  .metro-label::before { border-right-color: transparent !important; }
</style>
</head>
<body>
<div id="map"></div>
<script>
var map = L.map('map',{zoomControl:true,attributionControl:false,preferCanvas:true}).setView([${center[0]},${center[1]}],${zoom});
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{
  maxZoom:19,subdomains:'abcd'
}).addTo(map);
map.on('moveend',function(){var c=map.getCenter();window.ReactNativeWebView.postMessage(JSON.stringify({type:'mapMove',lat:c.lat,lng:c.lng,zoom:map.getZoom()}));});
var metroLabels=[];
var metroMarkers=[];
var metroPolylines=[];
var metroStations=[];
var metroPolyData=[];
${metroIconsJS}
window._metroLayer=L.layerGroup().addTo(map);
${metroDataJS}
function toggleMetro(){var z=map.getZoom();var vis=map.hasLayer(window._metroLayer);var showPoly=vis&&z>=10;var showMarkers=vis&&z>=12;var showLabels=vis&&z>=16;if(showPoly&&metroPolylines.length===0){metroPolyData.forEach(function(d){var p=L.polyline(d.coords,{color:d.color,weight:2.5,opacity:0.25,lineCap:'round'}).addTo(window._metroLayer);metroPolylines.push(p);});}else if(!showPoly&&metroPolylines.length>0){metroPolylines.forEach(function(p){window._metroLayer.removeLayer(p);});metroPolylines=[];}if(showMarkers&&metroMarkers.length===0){metroStations.forEach(function(s){var m=L.marker([s.lat,s.lng],{icon:s.icon,interactive:false}).addTo(window._metroLayer);metroMarkers.push(m);});}else if(!showMarkers&&metroMarkers.length>0){metroMarkers.forEach(function(m){window._metroLayer.removeLayer(m);});metroMarkers=[];}if(showLabels&&metroLabels.length===0){metroStations.forEach(function(s){var t=L.tooltip({permanent:true,direction:'right',offset:[6,0],className:'metro-label'}).setLatLng([s.lat,s.lng]).setContent(s.name);t.addTo(map);metroLabels.push(t);});}else if(!showLabels&&metroLabels.length>0){metroLabels.forEach(function(t){map.removeLayer(t);});metroLabels=[];}}
var toggleMetroLabels=toggleMetro;
map.on('zoomend',toggleMetro);
toggleMetro();
window._routeLayer=L.layerGroup().addTo(map);
window._busLayer=L.layerGroup().addTo(map);
window._walkLayer=L.layerGroup().addTo(map);
window._catIcon=L.divIcon({html:'<img src="${userMarkerSrc}" style="width:30px;height:30px;display:block;">',className:'user-marker',iconSize:[30,30],iconAnchor:[15,15]});
var _lpTimer=null,_lpPos=null,_mapEl=document.getElementById('map');
_mapEl.addEventListener('touchstart',function(e){if(e.touches.length!==1){clearTimeout(_lpTimer);return;}_lpPos={x:e.touches[0].clientX,y:e.touches[0].clientY};_lpTimer=setTimeout(function(){var latlng=map.containerPointToLatLng(L.point(_lpPos.x,_lpPos.y));window.ReactNativeWebView.postMessage(JSON.stringify({type:'mapLongPress',lat:latlng.lat,lng:latlng.lng}));},600);},{passive:true});
_mapEl.addEventListener('touchend',function(){clearTimeout(_lpTimer);},{passive:true});
_mapEl.addEventListener('touchmove',function(e){if(!_lpPos||e.touches.length!==1)return;var dx=e.touches[0].clientX-_lpPos.x,dy=e.touches[0].clientY-_lpPos.y;if(Math.sqrt(dx*dx+dy*dy)>10)clearTimeout(_lpTimer);},{passive:true});
window.ReactNativeWebView.postMessage(JSON.stringify({type:'ready'}));
</script>
</body>
</html>`;
}
