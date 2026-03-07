import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

export function generateToken(): string {
  return uuidv4();
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}
