import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import APP_ROUTE, { getPostLoginRedirect } from "@/lib/app-route";
import { validateMfaAccess } from "@/ee/mfa";

export function useMfaPageProtection() {
  const navigate = useNavigate();
  const location = useLocation();
  const [isValidating, setIsValidating] = useState(true);
  const [isValid, setIsValid] = useState(false);

  useEffect(() => {
    const checkAccess = async () => {
      const result = await validateMfaAccess();

      const search = location.search;

      if (!result.valid) {
        navigate(APP_ROUTE.AUTH.LOGIN + search);
        return;
      }

      const isOnChallengePage =
        location.pathname === APP_ROUTE.AUTH.MFA_CHALLENGE;
      const isOnSetupPage =
        location.pathname === APP_ROUTE.AUTH.MFA_SETUP_REQUIRED;

      if (result.requiresMfaSetup && !isOnSetupPage) {
        navigate(APP_ROUTE.AUTH.MFA_SETUP_REQUIRED + search);
      } else if (
        !result.requiresMfaSetup &&
        result.userHasMfa &&
        !isOnChallengePage
      ) {
        navigate(APP_ROUTE.AUTH.MFA_CHALLENGE + search);
      } else if (!result.isTransferToken) {
        navigate(getPostLoginRedirect());
      } else {
        setIsValid(true);
      }

      setIsValidating(false);
    };

    checkAccess();
  }, [navigate, location.pathname]);

  return { isValidating, isValid };
}
