using System;
using System.Collections.Generic;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;
using NpgsqlTypes;

#nullable disable

#pragma warning disable CA1814 // Prefer jagged arrays over multidimensional

namespace Runova.Website.Data.Migrations
{
    /// <inheritdoc />
    public partial class News : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "NewsItems",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Slug = table.Column<string>(type: "character varying(120)", maxLength: 120, nullable: false),
                    Title = table.Column<string>(type: "character varying(160)", maxLength: 160, nullable: false),
                    Summary = table.Column<string>(type: "character varying(400)", maxLength: 400, nullable: false),
                    BodyMarkdown = table.Column<string>(type: "text", nullable: false),
                    BodyHtml = table.Column<string>(type: "text", nullable: false),
                    Category = table.Column<int>(type: "integer", nullable: false),
                    Severity = table.Column<int>(type: "integer", nullable: false),
                    CveIds = table.Column<List<string>>(type: "text[]", nullable: false),
                    CvssScore = table.Column<decimal>(type: "numeric(3,1)", precision: 3, scale: 1, nullable: true),
                    Tags = table.Column<List<string>>(type: "text[]", nullable: false),
                    Status = table.Column<int>(type: "integer", nullable: false),
                    PublishedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: true),
                    UpdatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    xmin = table.Column<uint>(type: "xid", rowVersion: true, nullable: false),
                    SearchVector = table.Column<NpgsqlTsVector>(type: "tsvector", nullable: true)
                        .Annotation("Npgsql:TsVectorConfig", "english")
                        .Annotation("Npgsql:TsVectorProperties", new[] { "Title", "Summary", "BodyMarkdown" }),
                    SourceLinks = table.Column<string>(type: "jsonb", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_NewsItems", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "Technologies",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false),
                    Slug = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    Name = table.Column<string>(type: "character varying(80)", maxLength: 80, nullable: false),
                    Kind = table.Column<int>(type: "integer", nullable: false),
                    Detectable = table.Column<bool>(type: "boolean", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Technologies", x => x.Id);
                    table.UniqueConstraint("AK_Technologies_Slug", x => x.Slug);
                });

            migrationBuilder.CreateTable(
                name: "NewsItemTechnologies",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Technology = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: false),
                    VersionRange = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    FixedIn = table.Column<string>(type: "character varying(40)", maxLength: 40, nullable: true),
                    NewsItemId = table.Column<long>(type: "bigint", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_NewsItemTechnologies", x => x.Id);
                    table.ForeignKey(
                        name: "FK_NewsItemTechnologies_NewsItems_NewsItemId",
                        column: x => x.NewsItemId,
                        principalTable: "NewsItems",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_NewsItemTechnologies_Technologies_Technology",
                        column: x => x.Technology,
                        principalTable: "Technologies",
                        principalColumn: "Slug",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.InsertData(
                table: "Technologies",
                columns: new[] { "Id", "Detectable", "Kind", "Name", "Slug" },
                values: new object[,]
                {
                    { 1L, true, 0, "Runova", "runova" },
                    { 2L, true, 1, "Electron", "electron" },
                    { 3L, true, 1, "Node.js", "nodejs" },
                    { 4L, true, 2, "Git", "git" },
                    { 5L, true, 1, ".NET", "dotnet" },
                    { 6L, true, 2, "Docker", "docker" },
                    { 7L, true, 3, "Claude Code", "claude-code" },
                    { 8L, true, 3, "Codex CLI", "codex-cli" },
                    { 9L, true, 3, "Gemini CLI", "gemini-cli" },
                    { 10L, true, 3, "Grok CLI", "grok-cli" },
                    { 11L, true, 3, "Cursor CLI", "cursor-cli" },
                    { 12L, true, 3, "OpenCode", "opencode" },
                    { 13L, true, 3, "OpenClaude", "openclaude" },
                    { 14L, true, 3, "GitHub Copilot CLI", "copilot-cli" },
                    { 15L, true, 3, "Aider", "aider" },
                    { 16L, true, 3, "Goose", "goose" },
                    { 17L, true, 3, "Cline CLI", "cline-cli" },
                    { 18L, true, 3, "Continue CLI", "continue-cli" },
                    { 19L, true, 3, "Pi", "pi" },
                    { 20L, true, 3, "Muse Code", "muse-code" },
                    { 21L, true, 3, "FreeBuff", "freebuff-cli" },
                    { 22L, true, 3, "Qwen Code", "qwen-cli" },
                    { 23L, false, 1, "Python", "python" },
                    { 24L, false, 1, "Bun", "bun" },
                    { 25L, false, 1, "Deno", "deno" },
                    { 26L, false, 1, "Java", "java" },
                    { 27L, false, 1, "Go", "go" },
                    { 28L, false, 1, "Rust", "rust" },
                    { 29L, false, 1, "PHP", "php" },
                    { 30L, false, 2, "npm", "npm" },
                    { 31L, false, 2, "pnpm", "pnpm" },
                    { 32L, false, 2, "TypeScript", "typescript" },
                    { 33L, false, 2, "Visual Studio Code", "vscode" },
                    { 34L, false, 4, "GitHub Actions", "github-actions" },
                    { 35L, false, 2, "Android SDK", "android-sdk" },
                    { 36L, false, 2, "Flutter", "flutter" },
                    { 37L, false, 5, "OpenSSH", "openssh" },
                    { 38L, false, 6, "OpenSSL", "openssl" },
                    { 39L, false, 5, "nginx", "nginx" },
                    { 40L, false, 5, "PostgreSQL", "postgresql" },
                    { 41L, false, 5, "MySQL", "mysql" },
                    { 42L, false, 5, "Redis", "redis" },
                    { 43L, false, 0, "WordPress", "wordpress" },
                    { 44L, false, 5, "Kubernetes", "kubernetes" },
                    { 45L, false, 7, "Linux kernel", "linux-kernel" },
                    { 46L, false, 7, "Ubuntu", "ubuntu" },
                    { 47L, false, 7, "Debian", "debian" },
                    { 48L, false, 7, "Rocky Linux", "rocky-linux" },
                    { 49L, false, 7, "Windows", "windows" },
                    { 50L, false, 7, "macOS", "macos" }
                });

            migrationBuilder.CreateIndex(
                name: "IX_NewsItemTechnologies_NewsItemId",
                table: "NewsItemTechnologies",
                column: "NewsItemId");

            migrationBuilder.CreateIndex(
                name: "IX_NewsItemTechnologies_Technology",
                table: "NewsItemTechnologies",
                column: "Technology");

            migrationBuilder.CreateIndex(
                name: "IX_NewsItems_SearchVector",
                table: "NewsItems",
                column: "SearchVector")
                .Annotation("Npgsql:IndexMethod", "gin");

            migrationBuilder.CreateIndex(
                name: "IX_NewsItems_Slug",
                table: "NewsItems",
                column: "Slug",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_NewsItems_Status_PublishedAt",
                table: "NewsItems",
                columns: new[] { "Status", "PublishedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_NewsItems_Tags",
                table: "NewsItems",
                column: "Tags")
                .Annotation("Npgsql:IndexMethod", "gin");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "NewsItemTechnologies");

            migrationBuilder.DropTable(
                name: "NewsItems");

            migrationBuilder.DropTable(
                name: "Technologies");
        }
    }
}
