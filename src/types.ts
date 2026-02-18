/**
 * TypeScript definitions for OASA Telematics API responses.
 */

/* ── Static / Reference Data ─────────────────────────────────── */

export interface OasaLine {
  LineCode: string;
  LineID: string;
  LineDescr: string;
  LineDescrEng: string;
}

export interface OasaRoute {
  RouteCode: string;
  LineCode: string;
  RouteDescr: string;
  RouteDescrEng: string;
  RouteType: string;
  RouteDistance: string;
}

export interface OasaRouteDetail {
  routed_x: string;
  routed_y: string;
  routed_order: string;
}

export interface OasaStop {
  StopCode: string;
  StopID: string;
  StopDescr: string;
  StopDescrEng: string;
  StopStreet: string | null;
  StopStreetEng: string | null;
  StopHeading: string;
  StopLat: string;
  StopLng: string;
  RouteStopOrder?: string;
  StopType?: string;
  StopAmea?: string;
}

/* ── Real-Time Data ──────────────────────────────────────────── */

export interface OasaArrival {
  route_code: string;
  veh_code: string;
  /** Minutes until arrival */
  btime2: string;
}

export interface OasaBusLocation {
  VEH_NO: string;
  CS_DATE: string;
  CS_LAT: string;
  CS_LNG: string;
  ROUTE_CODE: string;
}

/* ── Nearest Stop (from getClosestStops) ─────────────────────── */

export interface OasaNearbyStop extends OasaStop {
  distance: string;
}

/* ── MasterLine Info (from webGetLinesWithMLInfo) ────────────── */

export interface OasaMLInfo {
  ml_code: string;
  sdc_code: string;
  line_code: string;
  line_id: string;
  line_descr: string;
  line_descr_eng: string;
  mld_master: string;
}

/* ── Schedule (from getSchedLines) ───────────────────────────── */

export interface OasaSchedEntry {
  line_id: string;
  sde_start1: string;   // "1900-01-01 HH:MM:SS"
  sde_end1: string | null;
  sde_line1: string;
  sde_sort: string;
  line_descr: string;
  line_descr_eng: string;
}

export interface OasaSchedLines {
  come: OasaSchedEntry[];
  go: OasaSchedEntry[];
}

/* ── App-Level Types ─────────────────────────────────────────── */

export interface FavoriteLine {
  lineCode: string;
  lineId: string;
  lineDescr: string;
  lineDescrEng: string;
}

export interface MapStamp {
  id: string;
  name: string;
  emoji: string;
  lat: number;
  lng: number;
}

export interface FavoriteStop {
  stopCode: string;
  stopName: string;
  lat: number;
  lng: number;
  /** Line codes to display. null/undefined = show all. */
  visibleLines?: string[] | null;
}
