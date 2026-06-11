declare module "sql.js" {
  namespace initSqlJs {
    interface Statement {
      bind(values?: unknown[]): boolean;
      step(): boolean;
      getAsObject(): Record<string, unknown>;
      get(): unknown[];
      free(): boolean;
      reset(): boolean;
    }

    interface Database {
      run(sql: string, params?: unknown[]): Database;
      prepare(sql: string, params?: unknown[]): Statement;
      exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
      export(): Uint8Array;
      close(): void;
    }

    interface SqlJsStatic {
      Database: { new (data?: ArrayLike<number> | Buffer | null): Database };
    }

    interface InitSqlJsConfig {
      locateFile?: (file: string) => string;
    }
  }

  function initSqlJs(config?: initSqlJs.InitSqlJsConfig): Promise<initSqlJs.SqlJsStatic>;

  export = initSqlJs;
}
