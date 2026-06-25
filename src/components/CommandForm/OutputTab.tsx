import type { ReactElement } from "react";
import type { TFunction } from "i18next";

import type { OutputSchema } from "../../types";
import { OutputSchemaEditor } from "./OutputSchemaEditor";
import type { FormTab } from "./formState";

export interface OutputTabProps {
  t: TFunction;
  active: boolean;
  value: OutputSchema | undefined;
  onChange: (next: OutputSchema | undefined) => void;
  sampleOutput: string | undefined;
}

/**
 * The command form's Output tab: the extraction-schema editor.
 * Presentational — state and handlers come from the parent CommandForm.
 */
export function OutputTab(props: OutputTabProps): ReactElement {
  const { t, active, value, onChange, sampleOutput } = props;
  const tab: FormTab = "output";
  return (
    <div
      role="tabpanel"
      id={`command-form-panel-${tab}`}
      aria-labelledby={`command-form-tab-${tab}`}
      hidden={!active}
      className="command-form__panel"
    >
      <OutputSchemaEditor
        value={value}
        onChange={onChange}
        sampleOutput={sampleOutput}
        t={t}
      />
    </div>
  );
}
