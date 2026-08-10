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

/* ── Daily Schedule (from getDailySchedule) ──────────────────── */

export interface OasaDailySchedEntry {
  sdd_line1: string;
  sdd_line2: string | null;
  sde_start1: string;  // "1900-01-01 HH:MM:SS"
  sde_end1: string | null;
  sde_start2: string | null;
  sde_end2: string | null;
  line_descr: string;
  line_descr_eng: string;
}

export interface OasaDailySchedule {
  come: OasaDailySchedEntry[];
  go: OasaDailySchedEntry[];
}

/* ── Bulk Data Types (undocumented endpoints) ────────────────── */

/** Stop record from `getAllStops` (snake_case, undocumented endpoint). */
export interface OasaBulkStop {
  stop_code: string;
  stop_descr: string;
  stop_descr_eng: string;
  stop_id: string;
  stop_lng: string;
  stop_lat: string;
  stop_heading: string | null;
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

/**
 * Where a saved stop's card sits on Home's canvas.
 *
 * The horizontal axis is columns and only columns: `col` ∈ {0,1,2} and `span` ∈
 * {1,2,3}, with `col + span <= 3`. Fractions of the width came first and were
 * replaced — a card could be any width, so its content had to adapt at measured
 * breakpoints and nothing lined up with anything. Three integers make "no card
 * is stranded off-screen" and "everything aligns" true by construction rather
 * than by a rescue routine.
 *
 * `y` and `h` stay continuous, in fractions of the canvas's *usable width* — the
 * same unit for both axes, so a card's aspect survives a rotation or a narrower
 * phone. Pixels were the obvious alternative and are the wrong one: a layout
 * authored on a 412dp phone would then need a reflow pass on a 360dp one, and
 * every such pass throws away some of the arrangement the user built.
 *
 * `h === 0` means the card has never been arranged: it is full span and stacked
 * in saved order, exactly as it was in 1.2.4. A record still carrying the old
 * `{x, w}` is quantised to the nearest column on load — see `migrateLayout` in
 * `features/home/layout`.
 */
export interface StopLayout {
  /** Leftmost column, 0-based. */
  col: number;
  /** Columns covered, at least 1, and never past the last column. */
  span: number;
  y: number;
  /**
   * Height — a **cache** of a derived value, not a size anybody chose.
   *
   * A card is exactly as tall as the buses its stop is showing, so this is
   * `hForBuses(span, count)` and the count is the length of `visibleLines` (or of
   * everything the stop serves, when that is null). It is stored all the same
   * because the count is only known once the stop's routes have come back off the
   * network, and the canvas has to lay out before then: without it every cold
   * start would place the cards at a fallback height, resolve the overlaps that
   * produced, and persist them.
   *
   * So it is written by the geometry and read only as a starting guess. A value
   * left behind by a build where the height was dragged is quantised to a whole
   * number of buses on the first pass — see the module comment in
   * `features/home/layout`.
   *
   * Zero, or no layout at all, still means "never arranged".
   */
  h: number;
}

export interface FavoriteStop {
  stopCode: string;
  stopName: string;
  lat: number;
  lng: number;
  /** Line codes to display. null/undefined = show all. */
  visibleLines?: string[] | null;
  /** Placement on Home's canvas. Absent for stops saved before 1.2.5 and for
   *  stops the user has never arranged — both flow full-width, in order. */
  layout?: StopLayout | null;
}
