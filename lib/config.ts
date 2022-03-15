
export interface EnvConfig {
    readonly environment: string;
    readonly account: string;
    readonly primaryCidr: string;
    readonly secondaryCidr: string;
    readonly primaryRegion: string;
    readonly secondaryRegion: string;
};
export interface Config {
    readonly primary: boolean;
    readonly cidr:string;
    readonly primaryRegion: string;
    readonly secondaryRegion: string;
};

export interface ReplicaConfig {
    readonly primaryRegion: string;
    readonly secondaryRegion: string;
};