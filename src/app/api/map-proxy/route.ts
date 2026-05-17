import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');

  if (!url) {
    return NextResponse.json(
      { error: 'Параметр url обязателен' },
      { status: 400 }
    );
  }

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return NextResponse.json(
      { error: 'Некорректный URL' },
      { status: 400 }
    );
  }

  // Only allow http/https
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return NextResponse.json(
      { error: 'Только HTTP/HTTPS ссылки поддерживаются' },
      { status: 400 }
    );
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'OrienteeringApp/1.0',
        'Accept': '*/*',
      },
      signal: AbortSignal.timeout(30000), // 30s timeout
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Сервер вернул ошибку: ${response.status} ${response.statusText}` },
        { status: response.status }
      );
    }

    const contentType = response.headers.get('content-type') || '';
    const contentLength = response.headers.get('content-length') || '';

    // Limit file size to 50MB
    if (contentLength && parseInt(contentLength) > 50 * 1024 * 1024) {
      return NextResponse.json(
        { error: 'Файл слишком большой (максимум 50 МБ)' },
        { status: 413 }
      );
    }

    const data = await response.arrayBuffer();

    // Pass content type and length as custom headers for client to read
    return new NextResponse(data, {
      status: 200,
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
        'X-Content-Type': contentType,
        'X-Content-Length': data.byteLength.toString(),
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err: any) {
    if (err.name === 'TimeoutError') {
      return NextResponse.json(
        { error: 'Время ожидания истекло (30с)' },
        { status: 504 }
      );
    }
    return NextResponse.json(
      { error: `Не удалось загрузить файл: ${err.message}` },
      { status: 500 }
    );
  }
}
