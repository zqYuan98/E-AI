/** Public member metadata. Credentials and session hashes never leave the backend. */
export interface Member {
  id: number;
  username: string;
  name: string;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMember {
  username: string;
  name?: string;
  password: string;
}

export interface ResetMember {
  password: string;
}
