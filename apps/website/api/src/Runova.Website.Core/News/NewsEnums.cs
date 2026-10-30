namespace Runova.Website.Core.News;

// The numbers are what the database stores, so they never change; JSON and query strings use the
// names (see ApiEnums).

/// <summary>What a news item is about, from the contract's category table.</summary>
public enum NewsCategory
{
    Security = 0,
    Release = 1,
    Deprecation = 2,
    EndOfLife = 3,
    Ai = 4,
    Tooling = 5,
    Industry = 6,
}

/// <summary>How much a news item matters, from lowest to highest. <c>minSeverity</c> uses this order.</summary>
public enum NewsSeverity
{
    Info = 0,
    Low = 1,
    Medium = 2,
    High = 3,
    Critical = 4,
}

/// <summary>Where a news item is in its life. Only <see cref="Published"/> is ever public.</summary>
public enum NewsStatus
{
    Draft = 0,
    Scheduled = 1,
    Published = 2,
    Archived = 3,
}

public enum TechnologyKind
{
    App = 0,
    Runtime = 1,
    Tool = 2,
    AiCli = 3,
    Service = 4,
    Server = 5,
    Library = 6,
    Os = 7,
}

/// <summary>The orders <c>GET /api/v1/news</c> can sort by.</summary>
public enum NewsSort
{
    /// <summary><c>-publishedAt</c>, the default.</summary>
    Newest,

    /// <summary><c>publishedAt</c>.</summary>
    Oldest,

    /// <summary><c>-severity</c>: the most severe first, then the newest.</summary>
    Severity,
}
