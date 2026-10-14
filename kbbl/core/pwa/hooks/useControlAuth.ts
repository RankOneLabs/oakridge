import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthStatus } from "../../auth-wire";
import { fetchAuthStatus, signInWithToken, type SignInFailure } from "../lib/control-auth";

const AUTH_STATUS_KEY = ["auth-status"] as const;

export interface ControlAuth {
  /** Null until kbbl answers, and when it cannot: the server still enforces its policy either way. */
  readonly status: AuthStatus | null;
  readonly is_loading: boolean;
  readonly signIn: (token: string) => void;
  readonly is_signing_in: boolean;
  readonly failure: SignInFailure | null;
}

/** kbbl's control credential: whether the browser holds it, and the exchange of a token for its cookie. */
export function useControlAuth(): ControlAuth {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: AUTH_STATUS_KEY, queryFn: fetchAuthStatus, staleTime: Infinity, retry: false });
  const sign_in = useMutation({
    mutationFn: async (token: string) => {
      const result = await signInWithToken(token);
      if (!result.ok) throw result.error;
      return result.value;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AUTH_STATUS_KEY }),
  });
  return {
    status: status.data ?? null,
    is_loading: status.isPending,
    signIn: (token) => sign_in.mutate(token),
    is_signing_in: sign_in.isPending,
    failure: (sign_in.error as SignInFailure | null) ?? null,
  };
}
