# Virtual Satellite Lab v0.1

여러 소형위성의 신호를 하나의 가상 안테나처럼 합성하는 조건을 실험하는 브라우저 앱입니다.

## 실행
```bash
npm test
npm run build
python3 -m http.server 8000 --directory dist
```
브라우저에서 `http://localhost:8000`을 엽니다. 외부 API/CDN/서버 계산이 필요 없습니다. `render.yaml`으로 Render Static Site 배포가 가능합니다.

## V0.1
- 1~64개 노드: Grid / Ring / Line / Random
- 2/20/30 GHz 및 임의 주파수
- 구면파 거리, 실제 위치와 추정 위치 분리
- 총 RF 전력 고정 / 노드당 전력 고정
- Estimated / Oracle / None 위상 보정
- 경로 추정오차, 독립 RF 위상오차, 주파수 편차
- 결맞음 손실, 비결맞음 기준 대비 이득
- 2D 초점 지도, 1D 절단면, 복소 위상 벡터
- 평균 결맞음 손실 목표에서 허용 위상·경로 RMS 역산
- JSON 저장/복원, CSV 결과 저장

## 주의
협대역 단일 반송파의 순간 분산배열 실험입니다. 실제 5G/6G 용량·BER, 편대유지 성능, 실제 RF 하드웨어 성능을 뜻하지 않습니다. `path error RMS`는 보정 후 남는 등가 전파경로 오차이며 3차원 위치유지 오차와 동일하지 않습니다.
