import type { Shell, VariableSpec } from "./command";
import type { Platform } from "./platform";

// Контент кнопки: ссылка на библиотечную команду ИЛИ inline-скрипт.
export type MiniAppAction =
  // Ссылка на существующую глобальную команду по id (как workflow node).
  | { kind: "commandRef"; commandId: string }
  // Inline-скрипт, автономно живущий внутри мини-приложения.
  | {
      kind: "inline";
      name: string;
      script: string;
      shell?: Shell;
      args?: string[];
      workingDir?: string;
      env?: Record<string, string>;
      runAsAdmin?: boolean;
      variables?: VariableSpec[];
    };

// Источник значения статуса.
export type StatusSource =
  | { kind: "commandRef"; commandId: string }
  | { kind: "inline"; script: string; shell?: Shell; variables?: VariableSpec[] };

// Как вывести статус из результата команды.
export type StatusMapping = {
  // Имя поля из outputSchema (по умолчанию returnValue).
  field?: string;
  // Преобразование строкового значения в индикатор.
  mode: "raw" | "mapped";
  // Для mode: "mapped" — value -> label/color.
  rules?: {
    match: string;
    // Стратегия сравнения `match` с сырым значением зонда: точное равенство
    // (по умолчанию, если поле отсутствует — обратная совместимость со
    // старыми сохранёнными правилами), вхождение подстроки, либо regex.
    matchMode?: "exact" | "contains" | "regex";
    label: string;
    color?: string;
  }[];
};

// Положение и размер виджета на холсте редактора (в пикселях).
export interface WidgetLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Размер главной панели мини-приложения (в пикселях). Это свойство самого
// мини-приложения, а не виджета: панель — это bordered-прямоугольник, внутри
// которого размещаются виджеты; перетаскивается за маркер в правом нижнем углу
// и рендерится раннером в указанном размере.
export interface PanelSize {
  w: number;
  h: number;
}

// Стиль отображения текстового виджета (статичная подпись).
export interface TextStyle {
  fontSize: number; // px, default 14
  color?: string; // token like "var(--color-text)" or a hex; undefined = default text color
  bold: boolean; // default false
  italic: boolean; // default false
  align: "left" | "center" | "right"; // default "left"
}

// Стиль отображения кнопки/переключателя. В отличие от TextStyle — не
// обязателен на уровне виджета: `undefined` означает полностью дефолтный вид
// (нулевые визуальные изменения для уже сохранённых виджетов).
export interface WidgetStyle {
  color?: string; // token like "var(--color-...)" or a hex; undefined = theme default
  variant: "fill" | "outline"; // default "fill"
}

// Один виджет на панели.
export type MiniAppWidget =
  | {
      id: string;
      kind: "button";
      layout: WidgetLayout;
      label: string;
      icon?: string;
      action: MiniAppAction;
      style?: WidgetStyle;
    }
  | {
      id: string;
      kind: "toggle";
      layout: WidgetLayout;
      label: string;
      onAction: MiniAppAction;
      offAction: MiniAppAction;
      status?: {
        source: StatusSource;
        intervalMs?: number;
        mapping: StatusMapping;
        // Значение статуса, означающее «переключатель включён». Сравнивается
        // (без учёта регистра и пробелов по краям) с сырым значением зонда и с
        // его отображаемой меткой. Когда поле не задано, используется старая
        // эвристика «зонд завершился успешно» — см. `resolveToggleOnState`.
        onValue?: string;
      };
      style?: WidgetStyle;
    }
  | {
      id: string;
      kind: "status";
      layout: WidgetLayout;
      label: string;
      source: StatusSource;
      intervalMs: number;
      mapping: StatusMapping;
    }
  | {
      id: string;
      kind: "artifact";
      layout: WidgetLayout;
      name: string;
      label: string;
      value: string;
      variant: "path" | "text" | "secret";
      // Persist this artifact's runtime value back to the mini-app's SQLite
      // record so it survives an app restart. Default `false`/`undefined`.
      // MUST NEVER be `true` on a `secret` variant — enforced by editor
      // validation (`validateMiniApp.ts`) and independently re-checked at
      // the runner's write-back point.
      persist?: boolean;
    }
  | {
      id: string;
      kind: "text";
      layout: WidgetLayout;
      // Внутренняя подпись для списка/сводки виджетов в редакторе (как у
      // прочих виджетов). ОТОБРАЖАЕТСЯ не она, а `content`.
      label: string;
      // Отображаемый текст; поддерживает ссылки на артефакты вида ${name}.
      content: string;
      style: TextStyle;
    };

// Само мини-приложение.
export interface MiniApp {
  id: string;
  name: string;
  /**
   * Optional i18next translation key for the display name. When set, UI code
   * should render `t(nameKey)` instead of `name`. Used by built-in/demo
   * (seed) mini-apps so their labels follow the active language. User-created
   * mini-apps MUST NOT set this — their literal `name` is preserved as typed.
   * Mirrors `Command.nameKey`.
   */
  nameKey?: string;
  description?: string;
  /**
   * Optional i18next translation key for the display description. Same rules
   * as `nameKey`: seeds only, never user input. Mirrors
   * `Command.descriptionKey`.
   */
  descriptionKey?: string;
  icon?: string;
  widgets: MiniAppWidget[];
  tags: string[];
  categoryId?: string;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  runCount: number;
  os?: Platform[];
  // Размер главной панели (в пикселях). Виджеты размещаются внутри неё и
  // ограничены её границами; раннер рендерит панель в указанном размере.
  panelSize: PanelSize;
}

export type MiniAppView = "miniapps" | "miniapp-editor" | "miniapp-runner";
