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
    public const string PostCreate = "post.create";
    public const string PostUpdate = "post.update";
    public const string PostArchive = "post.archive";
    public const string PostPublish = "post.publish";
    public const string MediaUpload = "media.upload";
    public const string ApiClientCreate = "api-client.create";
    public const string ApiClientUpdate = "api-client.update";
    public const string ApiClientRevoke = "api-client.revoke";
    public const string ApiClientRotate = "api-client.rotate";
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
    public const string Post = "post";
    public const string Media = "media";
    public const string ApiClient = "api-client";
}
