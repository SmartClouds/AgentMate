using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Runova.ServerCore.Data.Migrations
{
    /// <inheritdoc />
    public partial class WebsitesAndCertificates : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AcmeAccounts",
                columns: table => new
                {
                    Id = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    DirectoryUrl = table.Column<string>(type: "TEXT", nullable: false),
                    Url = table.Column<string>(type: "TEXT", nullable: false),
                    ProtectedKey = table.Column<string>(type: "TEXT", nullable: false),
                    Status = table.Column<string>(type: "TEXT", nullable: false),
                    Contact = table.Column<string>(type: "TEXT", nullable: false),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AcmeAccounts", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "NginxReleases",
                columns: table => new
                {
                    Id = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    Release = table.Column<int>(type: "INTEGER", nullable: false),
                    Hash = table.Column<string>(type: "TEXT", maxLength: 64, nullable: false),
                    AppliedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    AppliedBy = table.Column<Guid>(type: "TEXT", nullable: true),
                    AppliedByName = table.Column<string>(type: "TEXT", maxLength: 256, nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_NginxReleases", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Sites",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", maxLength: 63, nullable: false),
                    Settings = table.Column<string>(type: "TEXT", nullable: false),
                    BasicAuthHashes = table.Column<string>(type: "TEXT", nullable: true),
                    ServerSnippet = table.Column<string>(type: "TEXT", nullable: true),
                    LocationSnippet = table.Column<string>(type: "TEXT", nullable: true),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    AppliedFingerprint = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Sites", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "StreamProxies",
                columns: table => new
                {
                    Id = table.Column<string>(type: "TEXT", maxLength: 63, nullable: false),
                    Settings = table.Column<string>(type: "TEXT", nullable: false),
                    CreatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    UpdatedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    AppliedFingerprint = table.Column<string>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_StreamProxies", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Certificates",
                columns: table => new
                {
                    SiteId = table.Column<string>(type: "TEXT", nullable: false),
                    Source = table.Column<string>(type: "TEXT", maxLength: 20, nullable: false),
                    DirectoryUrl = table.Column<string>(type: "TEXT", nullable: true),
                    Domains = table.Column<string>(type: "TEXT", nullable: false),
                    KeyType = table.Column<string>(type: "TEXT", maxLength: 20, nullable: false),
                    ChainPem = table.Column<string>(type: "TEXT", nullable: false),
                    ProtectedKey = table.Column<string>(type: "TEXT", nullable: false),
                    CertificateId = table.Column<string>(type: "TEXT", nullable: true),
                    Issuer = table.Column<string>(type: "TEXT", nullable: false),
                    NotBefore = table.Column<long>(type: "INTEGER", nullable: false),
                    NotAfter = table.Column<long>(type: "INTEGER", nullable: false),
                    IssuedAt = table.Column<long>(type: "INTEGER", nullable: false),
                    Replaced = table.Column<string>(type: "TEXT", nullable: true),
                    PreferredChain = table.Column<string>(type: "TEXT", nullable: true),
                    RevokedAt = table.Column<long>(type: "INTEGER", nullable: true),
                    AutoRenew = table.Column<bool>(type: "INTEGER", nullable: false),
                    RenewAt = table.Column<long>(type: "INTEGER", nullable: true),
                    WindowStart = table.Column<long>(type: "INTEGER", nullable: true),
                    WindowEnd = table.Column<long>(type: "INTEGER", nullable: true),
                    ExplanationUrl = table.Column<string>(type: "TEXT", nullable: true),
                    NextCheckAt = table.Column<long>(type: "INTEGER", nullable: true),
                    FailedAttempts = table.Column<int>(type: "INTEGER", nullable: false),
                    NextAttemptAt = table.Column<long>(type: "INTEGER", nullable: true),
                    LastAttemptAt = table.Column<long>(type: "INTEGER", nullable: true),
                    LastError = table.Column<string>(type: "TEXT", nullable: true),
                    LastJobId = table.Column<Guid>(type: "TEXT", nullable: true)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Certificates", x => x.SiteId);
                    table.ForeignKey(
                        name: "FK_Certificates_Sites_SiteId",
                        column: x => x.SiteId,
                        principalTable: "Sites",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "SiteDomains",
                columns: table => new
                {
                    Domain = table.Column<string>(type: "TEXT", maxLength: 253, nullable: false),
                    SiteId = table.Column<string>(type: "TEXT", nullable: false),
                    Position = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_SiteDomains", x => x.Domain);
                    table.ForeignKey(
                        name: "FK_SiteDomains_Sites_SiteId",
                        column: x => x.SiteId,
                        principalTable: "Sites",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AcmeAccounts_DirectoryUrl",
                table: "AcmeAccounts",
                column: "DirectoryUrl",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_SiteDomains_SiteId",
                table: "SiteDomains",
                column: "SiteId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "AcmeAccounts");

            migrationBuilder.DropTable(
                name: "Certificates");

            migrationBuilder.DropTable(
                name: "NginxReleases");

            migrationBuilder.DropTable(
                name: "SiteDomains");

            migrationBuilder.DropTable(
                name: "StreamProxies");

            migrationBuilder.DropTable(
                name: "Sites");
        }
    }
}
