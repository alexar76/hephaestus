import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export const LANGS = ['en', 'ru', 'es', 'fr', 'zh'] as const;
export type Lang = (typeof LANGS)[number];

type UiPack = Record<string, string>;
type UiTable = Record<Lang, UiPack>;

/** English baked in so the UI never flashes raw keys before /studio-ui-i18n.json loads. */
const FALLBACK_EN: UiPack = {
  page_title: 'HEPHAESTUS — the forge',
  brand_tagline: 'price the graph before you spend it',
  quota_free_runs: '{n} free runs left · ',
  quota_free_run: '{n} free run left · ',
  meta_unproven: '{n} of {h} hops unproven',
  meta_observed: 'every hop has an observed success rate',
  meta_empty: 'load an example to start',
  wizards: 'Wizards',
  clear: 'Clear',
  example: 'Example',
  copy_request: 'Copy request',
  copied: 'Copied',
  run: 'Run',
  running: 'Running…',
  tab_catalogue: 'Catalogue',
  tab_canvas: 'Canvas',
  tab_checks: 'Status',
  canvas_hint: 'Drag the BOX to move one step · drag empty grid = whole canvas moves · Space+drag also pans',
  guide_title: 'Start here',
  guide_lead:
    'This page chains market capabilities, shows the price before you pay, then runs the graph and gives you a receipt.',
  guide_step1: 'Tap Example or Wizards — you get a ready chain, not loose blocks.',
  guide_step2: 'Drag a box to move one module. Space + drag moves the whole canvas.',
  guide_step3: 'Wire modules: bottom (out) → top (in). Orange line = data flows.',
  guide_step4: 'When Status is green, press Run.',
  guide_foot:
    'Catalogue (advanced) inserts a step into the chain before Result — not a loose square on the side.',
  guide_dismiss: 'Hide',
  start_title: 'How to start',
  start_example: 'Try working example',
  start_example_hint: 'Two steps, wired, ready to Run',
  start_wizards: 'Pick a goal (Wizards)',
  start_wizards_hint: "Chains built from today's catalogue",
  expert_show: 'Browse all capabilities (advanced)',
  expert_hide: 'Hide catalogue',
  expert_banner: 'Each click inserts into the chain before Result. Fill Parameters if Run stays blocked.',
  palette_catalogue: 'Catalogue',
  palette_loading: 'Reading the signed manifest…',
  palette_error: 'Could not read the catalogue: {detail}.',
  palette_meta: '{n} capabilities · {w} wireable',
  palette_filter_ph: 'filter by id or description',
  palette_nothing: 'Nothing matches.',
  palette_blocked_input: 'declares no input fields — cannot be filled in',
  palette_blocked_output: 'declares no output schema — nothing downstream can use it',
  params_title: 'Parameters',
  params_select: 'Click a module on the canvas to edit its fields.',
  params_select_hint: 'Click a CAPABILITY box (with a price), not Start.',
  params_editing: 'Selected: {name}',
  params_click_capability: 'Start and Result have no parameters — click gaia.weather.read or similar.',
  params_stale_capability: 'This capability is no longer in the catalogue. Load Example to refresh.',
  trigger_note: 'Start marks where the graph begins. It is not a paid hop.',
  output_note: 'Result marks where the answer leaves the graph. It is not a paid hop.',
  reliability: 'reliability',
  no_description: 'No description published.',
  takes_no_input: 'This capability takes no input.',
  no_input_schema: 'No input schema published — parameters cannot be checked here.',
  ref_hint: 'A field can use a value from an earlier hop: ${hop.field}',
  checks_title: 'Status',
  checks_ok: 'Ready to run. Press Run in the header.',
  checks_disconnected_one: '1 extra module is not wired into the chain — Run is blocked.',
  checks_disconnected_many: '{n} extra modules are not wired into the chain — Run is blocked.',
  checks_disconnected_hint: 'You probably clicked the catalogue. Remove the extras or load the example.',
  checks_remove_loose: 'Remove extras',
  checks_load_example: 'Load working example',
  checks_missing_one: 'Fill in Parameters for {node}: {fields}',
  checks_missing_many: 'Fill in Parameters for {node}: {fields}',
  checks_show_details: 'Show technical details ({n})',
  checks_hide_details: 'Hide technical details',
  last_run: 'Last run',
  at_fault: 'at fault',
  cleared: 'cleared',
  trace_link: 'signed bill of materials →',
  wizards_head:
    "Pick what you want — each chain is built from today's catalogue, priced before you load it.",
  lang_switch: 'Language',
  handle_in: 'in',
  handle_out: 'out',
  needs_wire: 'not wired — drag from out → in',
  connect_hint_title: 'These blocks are not in the chain',
  connect_hint_body:
    '{n} module(s) sit alone on the canvas. Run stays blocked until they are wired or removed.',
  connect_hint_drag: 'Drag from the bottom (out) dot of one box to the top (in) dot of another.',
  connect_hint_click: 'Or press Example / Remove extras to get a clean runnable chain.',
  journey_label: 'What to do',
  journey_purpose: 'Build a chain → see the price → Run → get a signed receipt.',
  journey_step1: 'Load Example or a Wizard',
  journey_step2: 'Press Run when Status is green',
  journey_step3: 'Read Last run (the receipt)',
  remove_loose: 'Remove extras',
};

function readInitialLang(): Lang {
  const q = new URLSearchParams(window.location.search).get('lang');
  if (q && LANGS.includes(q as Lang)) return q as Lang;
  const stored =
    localStorage.getItem('mm_hub_lang') || localStorage.getItem('mm_cat_lang');
  if (stored && LANGS.includes(stored as Lang)) return stored as Lang;
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return LANGS.includes(nav as Lang) ? (nav as Lang) : 'en';
}

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  ready: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readInitialLang);
  const [ui, setUi] = useState<UiTable | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/studio-ui-i18n.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!alive || !data?.ui) return;
        setUi(data.ui as UiTable);
      })
      .catch(() => {
        /* English markup until fetch succeeds */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    const title = ui?.[lang]?.page_title ?? ui?.en?.page_title;
    if (title) document.title = title;
  }, [lang, ui]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    localStorage.setItem('mm_hub_lang', next);
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const pack = (ui && ui[lang]) || (ui && ui.en) || FALLBACK_EN;
      let s = pack[key] ?? ui?.en?.[key] ?? FALLBACK_EN[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          s = s.split(`{${k}}`).join(String(v));
        }
      }
      return s;
    },
    [ui, lang],
  );

  const value = useMemo(
    () => ({ lang, setLang, t, ready: Boolean(ui) }),
    [lang, setLang, t, ui],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}
