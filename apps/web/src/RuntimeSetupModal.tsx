import { useMemo, useState, type FormEvent } from "react";
import { api } from "./api";
import { useI18n } from "./i18n";
import type { SystemInfo } from "./types";

type ProviderPreset = "nus" | "ark" | "custom";

function presetFor(baseUrl: string): ProviderPreset {
  if (baseUrl.includes("soclaas-api.comp.nus.edu.sg")) return "nus";
  if (baseUrl.includes("ark.cn-beijing.volces.com")) return "ark";
  return "custom";
}

export function RuntimeSetupModal({
  system,
  required,
  onConfigured,
  onClose,
}: {
  system: SystemInfo | null;
  required: boolean;
  onConfigured: (system: SystemInfo) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const initialBaseUrl = system?.arkConfigured
    ? system.arkBaseUrl
    : "https://soclaas-api.comp.nus.edu.sg/v1";
  const [provider, setProvider] = useState<ProviderPreset>(() => presetFor(initialBaseUrl));
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(system?.arkModel || (presetFor(initialBaseUrl) === "nus" ? "qwen3.6:27b" : ""));
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = useMemo(
    () => apiKey.trim().length >= 8 && model.trim().length > 0 && baseUrl.trim().length > 0,
    [apiKey, baseUrl, model],
  );

  const chooseProvider = (next: ProviderPreset) => {
    setProvider(next);
    if (next === "nus") {
      setBaseUrl("https://soclaas-api.comp.nus.edu.sg/v1");
      setModel((current) => current.trim() && provider === "nus" ? current : "qwen3.6:27b");
    } else if (next === "ark") {
      setBaseUrl("https://ark.cn-beijing.volces.com/api/v3");
      if (provider === "nus" && model === "qwen3.6:27b") setModel("");
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const configured = await api.configureModelRuntime({
        apiKey: apiKey.trim(),
        model: model.trim(),
        baseUrl: baseUrl.trim(),
      });
      setApiKey("");
      onConfigured(configured);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop runtime-setup-backdrop" onMouseDown={() => { if (!required) onClose(); }}>
      <form className="modal runtime-setup-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div>
            <span className="eyebrow">OpenAI-compatible Runtime</span>
            <h2>{t("配置模型即可开始", "Configure a model to start")}</h2>
            <p>{t(
              "选择服务商并填写自己的 API Key。提交后，密钥只保存在当前服务进程内，不会写入项目数据或返回浏览器。",
              "Choose a provider and enter your own API key. After submission, the key stays only in the running server process and is never written to project data or returned to the browser.",
            )}</p>
          </div>
          {!required && <button type="button" onClick={onClose} aria-label={t("关闭", "Close")}>×</button>}
        </div>

        <label>
          {t("模型服务", "Model provider")}
          <select value={provider} onChange={(event) => chooseProvider(event.target.value as ProviderPreset)}>
            <option value="nus">NUS SOCaaS</option>
            <option value="ark">Volcengine Ark</option>
            <option value="custom">{t("其他 OpenAI-compatible 服务", "Other OpenAI-compatible provider")}</option>
          </select>
        </label>
        <label>
          API Key
          <input
            autoFocus
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="new-password"
            placeholder={t("粘贴你的 API Key", "Paste your API key")}
            required
          />
          <small>{t("提交后此输入框会立即清空，页面不会显示密钥。", "This field is cleared immediately after submission and the key is never displayed.")}</small>
        </label>
        <label>
          {t("模型 ID", "Model ID")}
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={provider === "ark" ? "ep-xxxxxxxx" : "qwen3.6:27b"}
            required
          />
        </label>
        <label>
          {t("Responses API 地址", "Responses API base URL")}
          <input
            type="url"
            value={baseUrl}
            onChange={(event) => { setBaseUrl(event.target.value); setProvider(presetFor(event.target.value)); }}
            placeholder="https://provider.example.com/v1"
            required
          />
          <small>{t("填写 API 根地址，不要附加 /responses。", "Enter the API base URL without appending /responses.")}</small>
        </label>

        {error && <div className="runtime-setup-error" role="alert">{error}</div>}
        <div className="runtime-secret-note">
          <strong>{t("部署提示", "Deployment note")}</strong>
          <span>{t(
            "浏览器配置适合本地验收和单实例演示；正式部署仍可通过 .env 预置凭据。服务重启后，内存配置需要重新填写。",
            "Browser setup is intended for local judging and single-instance demos. Deployments may still preconfigure .env. In-memory settings must be entered again after a server restart.",
          )}</span>
        </div>
        <div className="modal-footer">
          {!required && <button type="button" className="button button-ghost" onClick={onClose}>{t("取消", "Cancel")}</button>}
          <button className="button button-primary" disabled={saving || !canSubmit}>
            {saving ? t("正在保存…", "Saving…") : t("保存并开始使用", "Save and start")}
          </button>
        </div>
      </form>
    </div>
  );
}
