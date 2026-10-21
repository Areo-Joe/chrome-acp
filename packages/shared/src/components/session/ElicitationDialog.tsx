import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationPropertySchema,
} from "../../acp/types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

type FieldValue = string | number | boolean | string[];

/** Normalized view of the (extensible) elicitation property union. */
interface PropertyLike {
  type: string;
  title?: string | null;
  description?: string | null;
  default?: unknown;
  enum?: string[] | null;
  oneOf?: Array<{ const: string; title: string }> | null;
  items?: {
    enum?: string[] | null;
    anyOf?: Array<{ const: string; title: string }> | null;
  } | null;
  format?: string | null;
  minLength?: number | null;
  maxLength?: number | null;
  pattern?: string | null;
  minimum?: number | null;
  maximum?: number | null;
  minItems?: number | null;
  maxItems?: number | null;
}

type FormRequest = Extract<CreateElicitationRequest, { mode: "form" }>;
type UrlRequest = Extract<CreateElicitationRequest, { mode: "url" }>;

function isFormRequest(request: CreateElicitationRequest): request is FormRequest {
  return request.mode === "form" && "requestedSchema" in request;
}

function isUrlRequest(request: CreateElicitationRequest): request is UrlRequest {
  return request.mode === "url" && "url" in request;
}

// The SDK property union is extensible (unknown custom types); normalize the
// standard variants to the fields this form understands.
function asProperty(property: ElicitationPropertySchema): PropertyLike {
  return property as unknown as PropertyLike;
}

function schemaChoices(
  property: PropertyLike,
): Array<{ value: string; title: string }> {
  if (property.type === "string") {
    if (property.oneOf) {
      return property.oneOf.map((option) => ({
        value: option.const,
        title: option.title,
      }));
    }
    return (property.enum ?? []).map((value) => ({ value, title: value }));
  }
  if (property.type === "array") {
    const items = property.items;
    if (items?.anyOf) {
      return items.anyOf.map((option) => ({
        value: option.const,
        title: option.title,
      }));
    }
    return (items?.enum ?? []).map((value) => ({ value, title: value }));
  }
  return [];
}

function initialValue(property: PropertyLike): FieldValue {
  const fallback = property.default;
  switch (property.type) {
    case "string":
      return typeof fallback === "string" ? fallback : "";
    case "number":
    case "integer":
      return typeof fallback === "number" ? fallback : "";
    case "boolean":
      return typeof fallback === "boolean" ? fallback : false;
    case "array":
      return Array.isArray(fallback) ? (fallback as string[]) : [];
    default:
      return "";
  }
}

function isMissing(property: PropertyLike, value: FieldValue): boolean {
  if (property.type === "boolean") return false;
  if (property.type === "array") return !Array.isArray(value) || value.length === 0;
  return value === "";
}

// Reference: Zed's elicitation validator (bounds/pattern/items count).
function isValid(property: PropertyLike, value: FieldValue, required: boolean): boolean {
  if (property.type === "string") {
    const text = String(value ?? "");
    if (text === "") return !required;
    if (property.minLength != null && text.length < property.minLength) return false;
    if (property.maxLength != null && text.length > property.maxLength) return false;
    if (property.pattern) {
      try {
        if (!new RegExp(property.pattern).test(text)) return false;
      } catch {
        // Invalid patterns are ignored rather than blocking the form.
      }
    }
    // Reference: Zed validates the declared string format.
    if (property.format === "email") {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
    }
    if (property.format === "uri") {
      try {
        new URL(text);
        return true;
      } catch {
        return false;
      }
    }
    if (property.format === "date" || property.format === "date-time") {
      return !Number.isNaN(Date.parse(text));
    }
    return true;
  }

  if (property.type === "number" || property.type === "integer") {
    const text = String(value ?? "").trim();
    if (text === "") return !required;
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) return false;
    if (property.type === "integer" && !Number.isInteger(parsed)) return false;
    if (property.minimum != null && parsed < property.minimum) return false;
    if (property.maximum != null && parsed > property.maximum) return false;
    return true;
  }

  if (property.type === "array") {
    const selected = Array.isArray(value) ? value : [];
    if (selected.length === 0) return !required;
    if (property.minItems != null && selected.length < property.minItems) return false;
    if (property.maxItems != null && selected.length > property.maxItems) return false;
    return true;
  }

  return true;
}

/**
 * Renders an ACP elicitation (`elicitation/create`).
 *
 * Reference: Zed's form/url elicitation handlers; form fields are generated
 * from the requested JSON schema.
 */
export function ElicitationCard({
  request,
  onRespond,
}: {
  request: CreateElicitationRequest;
  onRespond: (response: CreateElicitationResponse) => void;
}) {
  const formRequest = isFormRequest(request) ? request : null;
  const properties = useMemo(() => {
    const raw = formRequest?.requestedSchema.properties ?? {};
    const normalized: Record<string, PropertyLike> = {};
    for (const [key, property] of Object.entries(raw)) {
      normalized[key] = asProperty(property);
    }
    return normalized;
  }, [formRequest]);

  const required = useMemo(
    () => new Set(formRequest?.requestedSchema.required ?? []),
    [formRequest],
  );

  const [values, setValues] = useState<Record<string, FieldValue>>(() => {
    const initial: Record<string, FieldValue> = {};
    for (const [key, property] of Object.entries(properties)) {
      initial[key] = initialValue(property);
    }
    return initial;
  });

  if (isUrlRequest(request)) {
    return (
      <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 px-3 py-2">
        <div className="text-sm font-medium">Agent action required</div>
        <p className="mt-1 text-xs text-muted-foreground">{request.message}</p>
        <a
          href={request.url}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-sm text-blue-500 underline"
        >
          Open link <ExternalLink className="size-3.5" />
        </a>
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => onRespond({ action: "cancel" })}>
            Cancel
          </Button>
          <Button size="sm" variant="outline" onClick={() => onRespond({ action: "decline" })}>
            Decline
          </Button>
          <Button size="sm" onClick={() => onRespond({ action: "accept" })}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  if (!formRequest) {
    return (
      <div className="rounded-lg border px-3 py-2">
        <div className="text-sm font-medium">Agent action required</div>
        <p className="mt-1 text-xs text-muted-foreground">{request.message}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          This elicitation mode is not supported by this client.
        </p>
        <div className="mt-3 flex justify-end">
          <Button size="sm" onClick={() => onRespond({ action: "decline" })}>
            Decline
          </Button>
        </div>
      </div>
    );
  }

  const canSubmit = Object.entries(properties).every(([key, property]) => {
    const value = values[key] ?? "";
    if (isMissing(property, value) && !required.has(key)) return true;
    return isValid(property, value, required.has(key));
  });

  const submit = () => {
    const content: Record<string, ElicitationContentValue> = {};
    for (const [key, property] of Object.entries(properties)) {
      const value = values[key];
      if (value === undefined) continue;
      // Reference: Zed omits optional empty fields instead of sending ""/false.
      if (property.type === "number") {
        if (String(value).trim() !== "") content[key] = Number(value);
      } else if (property.type === "integer") {
        if (String(value).trim() !== "") {
          content[key] = Number.parseInt(String(value), 10);
        }
      } else if (property.type === "boolean") {
        if (required.has(key) || Boolean(value) || property.default !== undefined) {
          content[key] = Boolean(value);
        }
      } else if (property.type === "array") {
        const selected = Array.isArray(value) ? [...value] : [];
        // Reference: Zed sorts multi-select values before responding.
        selected.sort();
        if (selected.length > 0 || required.has(key)) content[key] = selected;
      } else {
        if (String(value) !== "" || required.has(key)) content[key] = String(value);
      }
    }
    onRespond({ action: "accept", content });
  };

  return (
    <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 px-3 py-2">
      <div className="text-sm font-medium">
        {formRequest?.requestedSchema.title ?? "Agent input required"}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {formRequest?.requestedSchema.description ?? request.message}
      </p>

      <div className="mt-3 flex flex-col gap-3">
          {Object.entries(properties).map(([key, property]) => {
            const label = property.title ?? key;
            const description = property.description;
            const choices = schemaChoices(property);

            return (
              <div key={key} className="flex flex-col gap-1.5">
                <Label htmlFor={`elicitation-${key}`}>
                  {label}
                  {required.has(key) && <span className="text-red-500"> *</span>}
                </Label>

                {property.type === "boolean" ? (
                  <input
                    id={`elicitation-${key}`}
                    type="checkbox"
                    className="size-4"
                    checked={Boolean(values[key])}
                    onChange={(event) =>
                      setValues((prev) => ({
                        ...prev,
                        [key]: event.target.checked,
                      }))
                    }
                  />
                ) : property.type === "array" ? (
                  <div className="flex flex-wrap gap-2">
                    {choices.map((choice) => {
                      const selected = Array.isArray(values[key])
                        ? (values[key] as string[])
                        : [];
                      return (
                        <label
                          key={choice.value}
                          className="flex items-center gap-1.5 text-xs"
                        >
                          <input
                            type="checkbox"
                            className="size-3.5"
                            checked={selected.includes(choice.value)}
                            onChange={(event) =>
                              setValues((prev) => ({
                                ...prev,
                                [key]: event.target.checked
                                  ? [...selected, choice.value]
                                  : selected.filter((value) => value !== choice.value),
                              }))
                            }
                          />
                          {choice.title}
                        </label>
                      );
                    })}
                  </div>
                ) : choices.length > 0 ? (
                  <select
                    id={`elicitation-${key}`}
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                    value={String(values[key] ?? "")}
                    onChange={(event) =>
                      setValues((prev) => ({ ...prev, [key]: event.target.value }))
                    }
                  >
                    <option value="">Select…</option>
                    {choices.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.title}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    id={`elicitation-${key}`}
                    type={
                      property.type === "number" || property.type === "integer"
                        ? "number"
                        : property.type === "string" && property.format === "date"
                          ? "date"
                          : property.type === "string" &&
                              property.format === "date-time"
                            ? "datetime-local"
                            : property.type === "string" && property.format === "email"
                              ? "email"
                              : property.type === "string" && property.format === "uri"
                                ? "url"
                                : "text"
                    }
                    value={String(values[key] ?? "")}
                    onChange={(event) =>
                      setValues((prev) => ({ ...prev, [key]: event.target.value }))
                    }
                  />
                )}

                {description && (
                  <p className="text-xs text-muted-foreground">{description}</p>
                )}
              </div>
            );
          })}
        </div>

      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => onRespond({ action: "cancel" })}>
          Cancel
        </Button>
        <Button size="sm" variant="outline" onClick={() => onRespond({ action: "decline" })}>
          Decline
        </Button>
        <Button size="sm" disabled={!canSubmit} onClick={submit}>
          Accept
        </Button>
      </div>
    </div>
  );
}
