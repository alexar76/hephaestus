import { LANGS, useI18n } from './i18n';

/** Same five locales as the hub terminal — shares `mm_hub_lang` in localStorage. */
export default function LangSwitch() {
  const { lang, setLang } = useI18n();

  return (
    <div className="lang-switch" role="group" aria-label="Language">
      {LANGS.map((code) => (
        <button
          key={code}
          type="button"
          data-lang={code}
          className={lang === code ? 'on' : undefined}
          onClick={() => setLang(code)}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
