"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  normalizeGeneratedAutomationId,
  resolveGeneratedUiInput,
  type GeneratedUiFieldSnapshot,
  type GeneratedUiInputBindings,
} from "@/src/lib/generatedUiActions";

type FieldRegistration = {
  getValue: () => string;
  required: boolean;
};

export type GeneratedAutomationAction = {
  automationId?: unknown;
  input?: GeneratedUiInputBindings;
  confirmation?: string;
};

export type GeneratedInvocationStatus = {
  busy: boolean;
  tone: "idle" | "pending" | "success" | "error";
  message: string | null;
};

type GeneratedUiInteractionValue = {
  registerField: (
    name: string,
    getValue: () => string,
    required: boolean,
  ) => () => void;
  invoke: (nodeId: bigint, action: GeneratedAutomationAction) => Promise<void>;
  statusFor: (nodeId: bigint) => GeneratedInvocationStatus;
};

const GeneratedUiInteractionContext =
  createContext<GeneratedUiInteractionValue | null>(null);

export function useGeneratedUiInteraction(): GeneratedUiInteractionValue | null {
  return useContext(GeneratedUiInteractionContext);
}

const AUTOMATIONS_UNAVAILABLE =
  "Automations are not available in this build.";

/**
 * Interaction context for generated form leaves (Input/Button). Field
 * registration works as before; invoking an automation always reports an
 * error — the automation backend was removed from this fork.
 */
export function GeneratedUiInteractionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const fieldsRef = useRef(new Map<string, FieldRegistration>());
  const [errors, setErrors] = useState(() => new Map<bigint, string>());

  const registerField = useCallback(
    (name: string, getValue: () => string, required: boolean) => {
      const registration = { getValue, required };
      fieldsRef.current.set(name, registration);
      return () => {
        if (fieldsRef.current.get(name) === registration) {
          fieldsRef.current.delete(name);
        }
      };
    },
    [],
  );

  const invoke = useCallback(
    async (nodeId: bigint, action: GeneratedAutomationAction) => {
      const automationId = normalizeGeneratedAutomationId(action.automationId);
      if (automationId == null) {
        setErrors((current) =>
          new Map(current).set(
            nodeId,
            "This button does not reference a valid automation.",
          ),
        );
        return;
      }
      const snapshots = new Map<string, GeneratedUiFieldSnapshot>();
      for (const [name, field] of fieldsRef.current) {
        snapshots.set(name, { value: field.getValue(), required: field.required });
      }
      const resolved = resolveGeneratedUiInput(action.input, snapshots);
      if (!resolved.ok) {
        setErrors((current) => new Map(current).set(nodeId, resolved.error));
        return;
      }
      setErrors((current) => new Map(current).set(nodeId, AUTOMATIONS_UNAVAILABLE));
    },
    [],
  );

  const statusFor = useCallback(
    (nodeId: bigint): GeneratedInvocationStatus => {
      const message = errors.get(nodeId);
      if (message) return { busy: false, tone: "error", message };
      return { busy: false, tone: "idle", message: null };
    },
    [errors],
  );

  const value = useMemo(
    () => ({ registerField, invoke, statusFor }),
    [invoke, registerField, statusFor],
  );
  return (
    <GeneratedUiInteractionContext.Provider value={value}>
      {children}
    </GeneratedUiInteractionContext.Provider>
  );
}
