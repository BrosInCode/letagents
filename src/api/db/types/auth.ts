export interface Account {
  id: string;
  provider: string;
  provider_user_id: string;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  account_id: string;
  token_hash: string;
  provider_access_token: string | null;
  expires_at: string;
  created_at: string;
}

export interface SessionAccount extends Session {
  provider: string;
  provider_user_id: string;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface OwnerToken {
  token_id: string;
  account_id: string;
  github_user_id: string;
  token_hash: string;
  provider_access_token: string | null;
  oauth_token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OwnerTokenAccount extends OwnerToken {
  provider: string;
  provider_user_id: string;
  login: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface AuthState {
  id: string;
  state: string;
  redirect_to: string | null;
  expires_at: string;
  created_at: string;
}
