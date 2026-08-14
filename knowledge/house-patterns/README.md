# House remediation patterns

Fixes this team has shipped and stands behind. The fix generator retrieves the closest match
here and is told to prefer it over inventing something new — so this folder is how the tool
learns the team's house style.

Add one file per pattern. Keep the same shape: a `## <name>` heading, the failing markup, the
corrected markup, and the rule of thumb. Anything in this folder is indexed on the next run;
delete `knowledge/.embeddings.json` to force a re-embed after large edits.
