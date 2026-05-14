import { createContext, useContext, useMemo } from "react";

const StakeholderRoleContext = createContext(null);

export function StakeholderRoleProvider({ role, displayName, username, welcomeName, onSwitchRole, children }) {
  const value = useMemo(
    () => ({
      role,
      displayName,
      username,
      welcomeName,
      onSwitchRole,
    }),
    [role, displayName, username, welcomeName, onSwitchRole]
  );
  return <StakeholderRoleContext.Provider value={value}>{children}</StakeholderRoleContext.Provider>;
}

export function useStakeholderRole() {
  const ctx = useContext(StakeholderRoleContext);
  return ctx;
}
