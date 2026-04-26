declare const process: {
    readonly argv: string[];
    readonly env: Record<string, string | undefined>;
    readonly stdin: any;
    readonly stdout: any;
    readonly stderr: any;
    readonly versions: { readonly node: string };
    exitCode?: number;
    cwd(): string;
    exit(code?: number): never;
};
