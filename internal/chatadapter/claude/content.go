//go:build unix

package claude

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"path"
	"strings"
)

// imageTypes are the media types of images the API takes.
var imageTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

// acpBlock is an ACP content block of a prompt, the members read.
type acpBlock struct {
	Type     string `json:"type"`
	Text     string `json:"text"`
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
	URI      string `json:"uri"`
	Resource *struct {
		URI      string `json:"uri"`
		Text     string `json:"text"`
		MimeType string `json:"mimeType"`
		Blob     string `json:"blob"`
	} `json:"resource"`
}

// claudeContent is the content of the program's user message for a
// prompt's ACP content blocks: the images first, then one text block, as
// the SDK's clients send them. The text joins the text blocks and names
// the files of resource links as @ mentions, which Claude Code reads.
func claudeContent(blocks []json.RawMessage, cwd string) ([]any, error) {
	var images []any
	var text strings.Builder
	mentioned := false
	add := func(s string, mention bool) {
		if text.Len() > 0 {
			if mention || mentioned {
				text.WriteByte(' ')
			} else {
				text.WriteString("\n\n")
			}
		}
		text.WriteString(s)
		mentioned = mention
	}
	image := func(mime, data string) error {
		if !imageTypes[mime] {
			return badRequest("an image of type " + mime)
		}
		if data == "" || base64.StdEncoding.DecodedLen(len(data)) == 0 {
			return badRequest("an image without data")
		}
		if _, err := base64.StdEncoding.DecodeString(data); err != nil {
			return badRequest("an image whose data is not base64")
		}
		images = append(images, map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": mime, "data": data}})
		return nil
	}
	for _, raw := range blocks {
		var b acpBlock
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, badRequest("a content block that is no object")
		}
		switch b.Type {
		case "text":
			if b.Text != "" {
				add(b.Text, false)
			}
		case "image":
			if err := image(b.MimeType, b.Data); err != nil {
				return nil, err
			}
		case "resource_link":
			if b.URI == "" {
				return nil, badRequest("a resource link without its uri")
			}
			add(mention(b.URI, cwd), true)
		case "resource":
			r := b.Resource
			switch {
			case r == nil:
				return nil, badRequest("a resource without its content")
			case r.Text != "":
				add(r.Text, false)
			case strings.HasPrefix(r.MimeType, "image/"):
				if err := image(r.MimeType, r.Blob); err != nil {
					return nil, err
				}
			default:
				return nil, badRequest("a resource of type " + r.MimeType)
			}
		default:
			return nil, badRequest("a content block of type " + b.Type)
		}
	}
	if len(images) == 0 && text.Len() == 0 {
		return nil, badRequest("an empty prompt")
	}
	out := images
	if text.Len() > 0 {
		out = append(out, textBlock(text.String()))
	}
	return out, nil
}

// mention is how a prompt names the resource at uri: a file as Claude
// Code's @ mention (relative to cwd when it is inside, in quotes when it
// has spaces), anything else as its uri.
func mention(uri, cwd string) string {
	u, err := url.Parse(uri)
	if err != nil || u.Scheme != "file" || !path.IsAbs(u.Path) {
		return uri
	}
	p := path.Clean(u.Path)
	if rel, ok := strings.CutPrefix(p, strings.TrimSuffix(cwd, "/")+"/"); ok && rel != "" {
		p = rel
	}
	if strings.ContainsAny(p, " \t\"") {
		return `@"` + strings.ReplaceAll(p, `"`, `\"`) + `"`
	}
	return "@" + p
}
