namespace Runova.Website.Core.Audit;

/// <summary>The audit actions of the contract, as <c>&lt;resource&gt;.&lt;verb&gt;</c>.</summary>
public static class AuditActions
{
    public const string UserInvite = "user.invite";
    public const string UserUpdate = "user.update";
    public const string UserDelete = "user.delete";
    public const string UserPasswordReset = "user.password-reset";
    public const string UserTwoFactorReset = "user.two-factor-reset";
    public const string NewsCreate = "news.create";
    public const string NewsUpdate = "news.update";
    public const string NewsArchive = "news.archive";
    public const string NewsPublish = "news.publish";
}

/// <summary>Who made a change.</summary>
public static class AuditActorKinds
{
    public const string User = "user";
    public const string ApiClient = "api-client";
    public const string System = "system";
}

/// <summary>What kind of thing a change was made to.</summary>
public static class AuditTargetTypes
{
    public const string User = "user";
    public const string News = "news";
}
