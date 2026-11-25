// The /how/traces explorer: the reader picks a path and sees every place a trace of it is kept.

import { useState } from "preact/hooks";
import { useI18n } from "../i18n/I18n.tsx";
import { DrawnSection, Paragraphs } from "./Drawing.tsx";
import { CHOICES, type Choice, tracesFor } from "./traces.ts";

export function TraceExplorer() {
  const { t } = useI18n();
  const text = t.technical.explorer;
  const [choice, setChoice] = useState<Choice>({ what: "file", link: "self", route: "direct" });
  const groups = Object.keys(CHOICES) as (keyof Choice)[];
  return (
    <DrawnSection id="explorer" heading={text.heading}>
      <Paragraphs body={text.body} />
      <div class="mt-6 grid gap-6 sm:grid-cols-3">
        {groups.map((group) => {
          const question = text.questions[group];
          const options: Record<string, string> = question.options;
          return (
            <fieldset key={group} class="m-0 border-0 p-0">
              <legend class="mb-2 p-0 font-semibold">{question.legend}</legend>
              {CHOICES[group].map((option) => (
                <label key={option} class="flex items-start gap-2 py-1 leading-snug">
                  <input
                    type="radio"
                    name={`explorer-${group}`}
                    value={option}
                    class="mt-0.5 size-4 flex-none accent-primary"
                    checked={choice[group] === option}
                    onChange={() => setChoice({ ...choice, [group]: option })}
                  />
                  {options[option]}
                </label>
              ))}
            </fieldset>
          );
        })}
      </div>
      <ul class="m-0 mt-8 list-none p-0">
        {Object.entries(text.places).map(([id, place]) => {
          const lines = tracesFor(place.lines, choice);
          const used = lines.length > 0;
          return (
            <li
              key={id}
              class={`mt-4 rounded-lg border border-border p-5 ${used ? "" : "text-muted-foreground"}`}
            >
              <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 class="m-0 text-[1.05rem] font-bold">{place.name}</h3>
                {used && (
                  <p class="m-0 text-[0.9rem] text-muted-foreground">
                    {text.kept}: {place.kept}
                  </p>
                )}
              </div>
              {used ? (
                <>
                  <ul class="mt-3 mb-0 list-disc pl-5 text-[0.95rem]">
                    {lines.map((line) => (
                      <li key={line} class="mt-1">
                        {line}
                      </li>
                    ))}
                  </ul>
                  <p class="mt-3 mb-0 text-[0.95rem]">
                    <strong>{text.never}:</strong> {place.never}
                  </p>
                </>
              ) : (
                <p class="mt-2 mb-0 text-[0.95rem]">{text.notUsed}</p>
              )}
            </li>
          );
        })}
      </ul>
    </DrawnSection>
  );
}
