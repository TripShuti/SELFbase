import { createContext, useContext } from "react";

// Only the connection provider is simulated; the production subscription hook
// and its React effect ordering are exercised unchanged in Chromium.
export const ConnectionContext = createContext<any>(null);
export function useSpacetimeDB() { return useContext(ConnectionContext); }
