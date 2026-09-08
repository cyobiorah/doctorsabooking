import session from "express-session";
import { db } from "./db";
export class MysqlSessionStore extends session.Store {
  get(
    id: string,
    cb: (err: unknown, data?: session.SessionData | null) => void,
  ) {
    db.session
      .findUnique({ where: { id } })
      .then((row) =>
        cb(
          null,
          row && row.expiresAt > new Date()
            ? (JSON.parse(row.data) as session.SessionData)
            : null,
        ),
      )
      .catch(cb);
  }
  set(
    id: string,
    data: session.SessionData,
    cb: (err?: unknown) => void = () => {},
  ) {
    const value = {
      data: JSON.stringify(data),
      expiresAt: new Date(data.cookie.expires ?? Date.now() + 86400000),
    };
    db.session
      .upsert({ where: { id }, create: { id, ...value }, update: value })
      .then(() => cb())
      .catch(cb);
  }
  destroy(id: string, cb: (err?: unknown) => void = () => {}) {
    db.session
      .deleteMany({ where: { id } })
      .then(() => cb())
      .catch(cb);
  }
  touch(
    id: string,
    data: session.SessionData,
    cb: (err?: unknown) => void = () => {},
  ) {
    this.set(id, data, cb);
  }
}
declare module "express-session" {
  interface SessionData {
    userId?: string;
    csrf?: string;
  }
}
