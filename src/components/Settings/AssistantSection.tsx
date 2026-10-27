import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Message } from "@arco-design/web-react";
import { NumberStepper } from "../NumberStepper";

import {
  deleteAssistantProvider,
  getAssistantSettings,
  listAssistantProviderModels,
  listAssistantProviderPresets,
  listAssistantProviders,
  saveAssistantProvider,
  setAssistantActiveModel,
  setAssistantProviderApiKey,
  setAssistantProviderEnabled,
  setAssistantProviderModelHidden,
  setAssistantSettings,
  setAssistantActiveProvider,
  testAssistantProvider,
} from "../../services/assistantService";
import type {
  AssistantProvider,
  AssistantProviderInput,
  AssistantProviderModel,
  AssistantProviderPreset,
  AssistantProviderTestResult,
  AssistantSettings,
} from "../../types/assistant";
import { isLocalAssistantBaseUrl } from "../../utils/assistantSettings";
import { Dropdown, type DropdownOption } from "../Dropdown";
import { ChevronIcon, PlusIcon } from "../icons";
import { ToggleSwitch } from "../ToggleSwitch";

interface AsyncState {
  loading: boolean;
  error: string | null;
}

export function AssistantSection(): ReactElement {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AssistantSettings | null>(null);
  const [providers, setProviders] = useState<AssistantProvider[]>([]);
  const [presets, setPresets] = useState<AssistantProviderPreset[]>([]);
  const [state, setState] = useState<AsyncState>({ loading: true, error: null });
  const [isBusy, setIsBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AssistantProviderInput>({
    name: "",
    kind: "lm-studio",
    baseUrl: "",
    enabled: true,
  });
  const [draftApiKey, setDraftApiKey] = useState("");
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftRemoteConsent, setDraftRemoteConsent] = useState(false);
  const [models, setModels] = useState<Record<string, AssistantProviderModel[]>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, AssistantProviderTestResult | undefined>
  >({});
  const [expandedModelLists, setExpandedModelLists] = useState<
    Record<string, boolean>
  >({});

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [loadedSettings, loadedProviders, loadedPresets] = await Promise.all([
        getAssistantSettings(),
        listAssistantProviders(),
        listAssistantProviderPresets(),
      ]);
      setSettings(loadedSettings);
      setProviders(loadedProviders);
      setPresets(loadedPresets);
      const modelLists = await Promise.all(
        loadedProviders.map((provider) =>
          listAssistantProviderModels(provider.id, true).catch(() => []),
        ),
      );
      const modelMap: Record<string, AssistantProviderModel[]> = {};
      loadedProviders.forEach((provider, index) => {
        const modelsForProvider = modelLists[index];
        if (modelsForProvider) modelMap[provider.id] = modelsForProvider;
      });
      setModels(modelMap);
      setState({ loading: false, error: null });
    } catch {
      setState({ loading: false, error: t("settings.assistant.loadError") });
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const updateSettings = <TKey extends keyof AssistantSettings>(
    key: TKey,
    value: AssistantSettings[TKey],
  ): void => {
    setSettings((current) =>
      current === null ? current : { ...current, [key]: value },
    );
  };

  const saveGlobal = useCallback(async (): Promise<void> => {
    if (settings === null) return;
    setIsBusy(true);
    try {
      await setAssistantSettings(settings);
      Message.success(t("settings.assistant.saved"));
    } catch {
      Message.error(t("settings.assistant.saveError"));
      await reload();
    } finally {
      setIsBusy(false);
    }
  }, [reload, settings, t]);

  const openAdd = useCallback(() => {
    setEditingProviderId(null);
    setDraft({
      name: "",
      kind: "lm-studio",
      baseUrl: "",
      enabled: true,
    });
    setDraftApiKey("");
    setDraftError(null);
    setDraftRemoteConsent(false);
    setEditorOpen(true);
  }, []);

  const openEdit = useCallback((provider: AssistantProvider) => {
    setEditingProviderId(provider.id);
    setDraft({
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
    });
    setDraftApiKey("");
    setDraftError(null);
    setDraftRemoteConsent(false);
    setEditorOpen(true);
  }, []);

  const applyDraftPreset = useCallback(
    (kind: string) => {
      const selected = presets.find((item) => item.kind === kind);
      if (!selected) return;
      const providerKind = selected.kind;
      setDraft((current) => ({
        ...current,
        kind: providerKind,
        baseUrl: selected.defaultBaseUrl,
      }));
    },
    [presets],
  );

  const editingProvider = useMemo(
    () =>
      editingProviderId === null
        ? null
        : (providers.find((provider) => provider.id === editingProviderId) ?? null),
    [editingProviderId, providers],
  );
  const draftPreset = useMemo(
    () => presets.find((preset) => preset.kind === draft.kind) ?? null,
    [draft.kind, presets],
  );
  const apiKeyRequired =
    draftPreset?.requiresApiKey === true && editingProvider?.hasApiKey !== true;
  const isAddingProvider = editingProviderId === null;
  const draftRemote =
    isAddingProvider &&
    draftPreset?.kind !== "codex" &&
    !isLocalAssistantBaseUrl(draft.baseUrl);
  const remoteConsentRequired =
    draftRemote && settings?.allowRemoteEndpoints !== true && !draftRemoteConsent;
  const saveDraft = useCallback(async (): Promise<void> => {
    if (settings === null) return;
    if (apiKeyRequired && draftApiKey.trim() === "") {
      setDraftError(t("settings.assistant.keyRequired"));
      return;
    }
    setDraftBusy(true);
    setDraftError(null);
    try {
      if (
        draftRemote &&
        draftRemoteConsent &&
        settings.allowRemoteEndpoints !== true
      ) {
        const nextSettings = {
          ...settings,
          allowRemoteEndpoints: true,
        };
        await setAssistantSettings(nextSettings);
        setSettings(nextSettings);
      }
      const saved = await saveAssistantProvider(draft, editingProviderId ?? undefined);
      if (draftApiKey.trim() !== "") {
        await setAssistantProviderApiKey(saved.id, draftApiKey.trim());
      }
      setEditorOpen(false);
      await reload();
      Message.success(t("settings.assistant.providerSaved"));
    } catch (error: unknown) {
      const details =
        typeof error === "string"
          ? error
          : error instanceof Error
            ? error.message
            : t("settings.assistant.providerSaveError");
      setDraftError(
        `${t("settings.assistant.providerSaveError")}: ${details}`,
      );
    } finally {
      setDraftBusy(false);
    }
  }, [
    apiKeyRequired,
    draft,
    draftApiKey,
    draftRemote,
    draftRemoteConsent,
    editingProviderId,
    reload,
    settings,
    t,
  ]);

  const testProvider = useCallback(
    async (providerId: string): Promise<void> => {
      setTestingId(providerId);
      setTestResults((current) => ({ ...current, [providerId]: undefined }));
      try {
        const result = await testAssistantProvider(providerId);
        setTestResults((current) => ({ ...current, [providerId]: result }));
        if (!result.ok) {
          Message.error(t("settings.assistant.testFailed"));
        } else {
          Message.success(
            t("settings.assistant.testSuccess", { count: result.modelCount }),
          );
        }
        const models = await listAssistantProviderModels(providerId, true);
        setModels((current) => ({ ...current, [providerId]: models }));
      } catch (error: unknown) {
        const details =
          typeof error === "string"
            ? error
            : error instanceof Error
              ? error.message
              : t("settings.assistant.testFailed");
        setTestResults((current) => ({
          ...current,
          [providerId]: {
            ok: false,
            modelCount: 0,
            error: details,
          },
        }));
        Message.error(t("settings.assistant.testFailed"));
      } finally {
        setTestingId(null);
      }
    },
    [t],
  );

  const removeProvider = useCallback(
    async (providerId: string): Promise<void> => {
      setIsBusy(true);
      try {
        await deleteAssistantProvider(providerId);
        await reload();
      } catch {
        Message.error(t("settings.assistant.providerDeleteError"));
      } finally {
        setIsBusy(false);
      }
    },
    [reload, t],
  );

  const changeModelVisibility = useCallback(
    async (
      provider: AssistantProvider,
      modelId: string,
      visible: boolean,
    ): Promise<void> => {
      const hidden = !visible;
      setModels((current) => ({
        ...current,
        [provider.id]: (current[provider.id] ?? []).map((model) =>
          model.modelId === modelId ? { ...model, hidden } : model,
        ),
      }));
      try {
        await setAssistantProviderModelHidden(provider.id, modelId, hidden);
        if (
          hidden &&
          settings?.activeProviderId === provider.id &&
          settings.activeModelId === modelId
        ) {
          const nextSettings = { ...settings, activeModelId: null };
          await setAssistantSettings(nextSettings);
          setSettings(nextSettings);
        }
      } catch {
        await reload();
        Message.error(t("settings.assistant.modelVisibilityError"));
      }
    },
    [reload, settings, t],
  );

  const changeEnabled = useCallback(
    async (provider: AssistantProvider, enabled: boolean): Promise<void> => {
      setProviders((current) =>
        current.map((item) => (item.id === provider.id ? { ...item, enabled } : item)),
      );
      try {
        await setAssistantProviderEnabled(provider.id, enabled);
      } catch {
        await reload();
      }
    },
    [reload],
  );

  const chooseModel = useCallback(
    async (provider: AssistantProvider, modelId: string): Promise<void> => {
      try {
        await setAssistantActiveModel(provider.id, modelId);
        setSettings((current) =>
          current === null
            ? current
            : {
                ...current,
                activeProviderId: provider.id,
                activeModelId: modelId,
              },
        );
      } catch {
        Message.error(t("settings.assistant.modelSelectError"));
      }
    },
    [t],
  );

  const chooseProvider = useCallback(
    async (providerId: string): Promise<void> => {
      if (providerId === "") {
        Message.error(t("settings.assistant.noProvider"));
        return;
      }
      try {
        await setAssistantActiveProvider(providerId);
        setSettings((current) =>
          current === null
            ? current
            : {
                ...current,
                activeProviderId: providerId,
                activeModelId: null,
              },
        );
      } catch {
        Message.error(t("settings.assistant.providerSelectError"));
      }
    },
    [t],
  );

  const activeModels = useMemo(() => {
    const id = settings?.activeProviderId;
    return id === undefined || id === null
      ? []
      : (models[id] ?? []).filter((model) => !model.hidden);
  }, [models, settings?.activeProviderId]);

  const activeModelOptions = useMemo<ReadonlyArray<DropdownOption>>(
    () => [
      { value: "", label: t("settings.assistant.noModel") },
      ...activeModels.map((model) => ({
        value: model.modelId,
        label: model.name,
      })),
    ],
    [activeModels, t],
  );

  const enabledProviders = useMemo(
    () => providers.filter((provider) => provider.enabled),
    [providers],
  );

  const toggleModelList = useCallback((providerId: string): void => {
    setExpandedModelLists((current) => ({
      ...current,
      [providerId]: !current[providerId],
    }));
  }, []);

  const activeProviderOptions = useMemo<ReadonlyArray<DropdownOption>>(
    () =>
      enabledProviders.map((provider) => ({
        value: provider.id,
        label: provider.name,
      })),
    [enabledProviders],
  );

  const providerKindOptions = useMemo<ReadonlyArray<DropdownOption>>(
    () =>
      presets.map((preset) => ({
        value: preset.kind,
        label: preset.label,
      })),
    [presets],
  );

  return (
    <section className="view-section">
      <h2 className="view-section__title">{t("settings.assistant.title")}</h2>

      {state.loading ? (
        <div className="empty-state settings-info">
          <div className="settings-info__body">{t("settings.assistant.loading")}</div>
        </div>
      ) : null}
      {state.error !== null ? (
        <div className="empty-state settings-info">
          <div className="settings-info__body assistant-settings__warning">
            {state.error}
          </div>
        </div>
      ) : null}

      {!state.loading && settings !== null ? (
        <>
          <div className="empty-state settings-info">
            <div className="settings-group settings-group--tight">
              <ToggleSwitch
                checked={settings.enabled}
                disabled={isBusy}
                onChange={(enabled) => updateSettings("enabled", enabled)}
                ariaLabel={t("settings.assistant.enabled")}
              />
              <span className="settings-inline-label">
                {t("settings.assistant.enabled")}
              </span>
            </div>
            <p className="form-hint">{t("settings.assistant.description")}</p>

            <div className="settings-group settings-group--tight settings-group--spaced-top">
              <ToggleSwitch
                checked={settings.allowRunSnapshots}
                disabled={isBusy}
                onChange={(allowed) =>
                  updateSettings("allowRunSnapshots", allowed)
                }
                ariaLabel={t("settings.assistant.runSnapshots")}
              />
              <span className="settings-inline-label">
                {t("settings.assistant.runSnapshots")}
              </span>
            </div>
            <p className="form-hint">
              {t("settings.assistant.runSnapshotsHint")}
            </p>
          </div>

          <div className="assistant-settings__grid">
            <div className="form-field">
              <span className="form-field__label">
                {t("settings.assistant.provider")}
              </span>
              <Dropdown
                value={settings.activeProviderId ?? ""}
                options={activeProviderOptions}
                disabled={activeProviderOptions.length === 0}
                ariaLabel={t("settings.assistant.provider")}
                placeholder={t("settings.assistant.noProvider")}
                onChange={(providerId) => void chooseProvider(providerId)}
              />
            </div>

            <div className="form-field">
              <span className="form-field__label">
                {t("settings.assistant.activeModel")}
              </span>
              <Dropdown
                value={settings.activeModelId ?? ""}
                options={activeModelOptions}
                disabled={
                  settings.activeProviderId === null || activeModels.length === 0
                }
                ariaLabel={t("settings.assistant.activeModel")}
                placeholder={t("settings.assistant.noModel")}
                onChange={(modelId) => {
                  const providerId = settings.activeProviderId;
                  if (providerId !== null && modelId !== "") {
                    void (async () => {
                      const provider = providers.find((item) => item.id === providerId);
                      if (provider) await chooseModel(provider, modelId);
                    })();
                  }
                }}
              />
            </div>

            <div className="form-field">
              <span className="form-field__label">
                {t("settings.assistant.timeout")}
              </span>
              <NumberStepper
                value={Math.round(settings.timeoutMs / 1_000)}
                min={1}
                max={300}
                step={1}
                ariaLabel={t("settings.assistant.timeout")}
                decrementLabel={t("common.decrement")}
                incrementLabel={t("common.increment")}
                onChange={(seconds) =>
                  updateSettings("timeoutMs", seconds * 1_000)
                }
              />
            </div>
          </div>

          <div className="settings-group">
            <button
              type="button"
              className="btn btn--primary"
              disabled={isBusy}
              onClick={() => void saveGlobal()}
            >
              {t("common.save")}
            </button>
          </div>

          <section className="view-section assistant-settings__providers-section">
            <h3 className="view-section__title">
              {t("settings.assistant.providersTitle")}
            </h3>
            <div className="settings-group">
              <button
                type="button"
                className="btn btn--primary"
                disabled={isBusy}
                onClick={openAdd}
              >
                <PlusIcon />
                {t("settings.assistant.addProvider")}
              </button>
            </div>

            <div className="assistant-settings__providers">
              {providers.length === 0 ? (
                <p className="form-hint">{t("settings.assistant.noProviders")}</p>
              ) : null}
              {providers.map((provider) => (
                <article key={provider.id} className="assistant-provider-card">
                  <div className="assistant-provider-card__header">
                    <div>
                      <strong>{provider.name}</strong>
                      <span>
                        {presets.find((preset) => preset.kind === provider.kind)?.label ??
                          provider.kind}
                      </span>
                    </div>
                    <ToggleSwitch
                      checked={provider.enabled}
                      disabled={isBusy}
                      onChange={(enabled) => void changeEnabled(provider, enabled)}
                      ariaLabel={t("settings.assistant.providerEnabled")}
                    />
                  </div>
                  {provider.kind === "codex" ? (
                    <p className="form-hint">
                      {t("settings.assistant.codexConfigHint")}
                    </p>
                  ) : (
                    <>
                      <p className="assistant-provider-card__url">{provider.baseUrl}</p>
                      <p className="form-hint">
                        {provider.hasApiKey
                          ? t("settings.assistant.keyStored")
                          : t("settings.assistant.keyEmpty")}
                      </p>
                    </>
                  )}
                  <div className="assistant-provider-card__actions">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={testingId === provider.id}
                      onClick={() => void testProvider(provider.id)}
                    >
                      {testingId === provider.id
                        ? t("settings.assistant.testing")
                        : t("settings.assistant.test")}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => openEdit(provider)}
                    >
                      {t("common.edit")}
                    </button>
                    <button
                      type="button"
                      className="btn btn--danger"
                      disabled={isBusy}
                      onClick={() => void removeProvider(provider.id)}
                    >
                      {t("common.delete")}
                    </button>
                  </div>
                  {testResults[provider.id] && !testResults[provider.id]?.ok ? (
                    <p className="assistant-panel__error">
                      {testResults[provider.id]?.error ??
                        t("settings.assistant.testFailed")}
                    </p>
                  ) : null}
                  {testResults[provider.id]?.ok ? (
                    <p className="form-hint">
                      {t("settings.assistant.testSuccess", {
                        count: testResults[provider.id]?.modelCount ?? 0,
                      })}
                    </p>
                  ) : null}
                  <div className="form-field">
                    <button
                      type="button"
                      className={`assistant-provider-card__models-toggle${
                        expandedModelLists[provider.id] ? " is-open" : ""
                      }`}
                      aria-expanded={expandedModelLists[provider.id] === true}
                      aria-controls={`assistant-provider-models-${provider.id}`}
                      onClick={() => toggleModelList(provider.id)}
                    >
                      <span className="form-field__label">
                        {t("settings.assistant.providerModels")}
                      </span>
                      <span className="assistant-provider-card__models-chevron">
                        <ChevronIcon />
                      </span>
                    </button>
                    {expandedModelLists[provider.id] === true ? (
                      <>
                        <p className="form-hint">
                          {t("settings.assistant.providerModelsHint")}
                        </p>
                        <div
                          id={`assistant-provider-models-${provider.id}`}
                          className="assistant-provider-card__models"
                        >
                          {(models[provider.id] ?? []).map((model) => (
                            <div
                              key={model.modelId}
                              className="assistant-provider-card__model"
                            >
                          <ToggleSwitch
                            checked={!model.hidden}
                            disabled={testingId === provider.id}
                            ariaLabel={t("settings.assistant.modelVisibility", {
                              model: model.name,
                            })}
                            onChange={(visible) =>
                              void changeModelVisibility(
                                provider,
                                model.modelId,
                                visible,
                              )
                            }
                          />
                              <span
                                className={`assistant-provider-card__model-name${
                                  model.hidden ? " is-hidden" : ""
                                }`}
                              >
                                {model.name}
                              </span>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </section>
        </>
      ) : null}

      {editorOpen ? (
        <div className="command-form__backdrop" role="presentation">
          <div className="command-form command-form--meta" role="dialog" aria-modal="true">
            <h2 className="command-form__title">
              {editingProviderId === null
                ? t("settings.assistant.addProvider")
                : t("settings.assistant.editProvider")}
            </h2>
            <div className="form-field">
              <span className="form-field__label">
                {t("settings.assistant.providerKind")}
              </span>
              <Dropdown
                value={draft.kind}
                options={providerKindOptions}
                onChange={applyDraftPreset}
                ariaLabel={t("settings.assistant.providerKind")}
              />
            </div>
            <label className="form-field">
              <span className="form-field__label">
                {t("settings.assistant.providerName")}
              </span>
              <input
                className="input"
                value={draft.name}
                placeholder={t("settings.assistant.providerNamePlaceholder")}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
              />
            </label>
            {draftPreset?.kind === "codex" ? (
              <p className="form-hint">
                {t("settings.assistant.codexConfigHint")}
              </p>
            ) : (
              <>
                <label className="form-field">
                  <span className="form-field__label">
                    {t("settings.assistant.baseUrl")}
                  </span>
                  <input
                    className="input"
                    value={draft.baseUrl}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, baseUrl: event.target.value }))
                    }
                  />
                </label>

                <label className="form-field">
                  <span
                    className={`form-field__label${
                      apiKeyRequired ? " form-field__label--required" : ""
                    }`}
                  >
                    {apiKeyRequired ? (
                      <>
                        <span className="form-field__required" aria-hidden="true">
                          *
                        </span>
                        {t("settings.assistant.apiKeyRequired")}
                      </>
                    ) : (
                      t("settings.assistant.apiKeyOptional")
                    )}
                  </span>
                  <input
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    value={draftApiKey}
                    aria-required={apiKeyRequired}
                    onChange={(event) => setDraftApiKey(event.target.value)}
                  />
                  <p className="form-hint">
                    {apiKeyRequired
                      ? t("settings.assistant.keyRequiredHint")
                      : editingProvider?.hasApiKey
                        ? t("settings.assistant.keyStored")
                        : t("settings.assistant.keyEmpty")}
                  </p>
                </label>
              </>
            )}
            {draftError !== null ? (
              <p className="assistant-panel__error">{draftError}</p>
            ) : null}
            <div className="command-form__actions">
              <button
                type="button"
                className="btn command-form__action command-form__action--cancel"
                onClick={() => setEditorOpen(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn--primary command-form__action"
                disabled={
                  draftBusy ||
                  (apiKeyRequired && draftApiKey.trim() === "") ||
                  remoteConsentRequired
                }
                onClick={() => void saveDraft()}
              >
                {t("common.save")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
